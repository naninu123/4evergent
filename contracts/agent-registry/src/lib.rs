//! AgentRegistry — on-chain agent identity on Soroban.
//!
//! MVP supports:
//! - register(caller, id, display_name, stellar_address, capabilities)
//! - update_metadata(caller, id, new_display_name, new_capabilities)
//! - deactivate(caller, id)
//! - query(id)
//! - authorization: every mutating entrypoint takes the acting `Address` and
//!   calls `require_auth()` as its first statement; only the registered owner
//!   may update/deactivate their own agent.
//!
//! Future: delegation, multi-sig registration, capability discovery events.

#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, String, Vec};

/// Max accepted length of an agent id, in bytes.
const MAX_ID_LEN: u32 = 64;

#[contracttype]
#[derive(Clone)]
pub struct AgentInfo {
    pub id: String,
    pub owner: Address,
    pub display_name: String,
    pub stellar_address: Address,
    pub capabilities: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub active: bool,
}

/// Per-agent records live under a single-key enum so the key type is
/// `#[contracttype]`-convertible (dynamic `String` payload supported).
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Agent(String),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    IdEmpty = 1,
    IdTooLong = 2,
    AlreadyRegistered = 3,
    NotFound = 4,
    NotAuthorized = 5,
}

#[contract]
pub struct AgentRegistry;

fn validate_id(id: &String) -> Result<(), Error> {
    if id.is_empty() {
        return Err(Error::IdEmpty);
    }
    if id.len() > MAX_ID_LEN {
        return Err(Error::IdTooLong);
    }
    Ok(())
}

/// Push the persistent entry's TTL toward the ledger max. Called on both the
/// write and the read path so actively-used records never expire.
fn bump_ttl(env: &Env, key: &DataKey) {
    let max = env.storage().max_ttl();
    env.storage().persistent().extend_ttl(key, max / 2, max);
}

#[contractimpl]
impl AgentRegistry {
    /// Register a new agent. The caller becomes the owner.
    pub fn register(
        env: Env,
        caller: Address,
        id: String,
        display_name: String,
        stellar_address: Address,
        capabilities: Vec<String>,
    ) -> Result<AgentInfo, Error> {
        caller.require_auth();
        validate_id(&id)?;
        let key = DataKey::Agent(id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyRegistered);
        }
        let now = env.ledger().timestamp();
        let info = AgentInfo {
            id: id.clone(),
            owner: caller,
            display_name,
            stellar_address,
            capabilities,
            created_at: now,
            updated_at: now,
            active: true,
        };
        env.storage().persistent().set(&key, &info);
        bump_ttl(&env, &key);
        Ok(info)
    }

    /// Update display_name and capabilities. Only the registered owner.
    pub fn update_metadata(
        env: Env,
        caller: Address,
        id: String,
        new_display_name: String,
        new_capabilities: Vec<String>,
    ) -> Result<AgentInfo, Error> {
        caller.require_auth();
        let key = DataKey::Agent(id);
        let mut info: AgentInfo = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;
        if info.owner != caller {
            return Err(Error::NotAuthorized);
        }
        info.display_name = new_display_name;
        info.capabilities = new_capabilities;
        info.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&key, &info);
        bump_ttl(&env, &key);
        Ok(info)
    }

    /// Deactivate the agent (tombstone; the record stays queryable).
    /// Only the registered owner.
    pub fn deactivate(env: Env, caller: Address, id: String) -> Result<bool, Error> {
        caller.require_auth();
        let key = DataKey::Agent(id);
        let mut info: AgentInfo = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;
        if info.owner != caller {
            return Err(Error::NotAuthorized);
        }
        info.active = false;
        info.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&key, &info);
        bump_ttl(&env, &key);
        Ok(true)
    }

    /// Query agent info. Anyone can query. Read path also bumps the TTL.
    pub fn query(env: Env, id: String) -> Result<Option<AgentInfo>, Error> {
        validate_id(&id)?;
        let key = DataKey::Agent(id);
        let info: Option<AgentInfo> = env.storage().persistent().get(&key);
        if info.is_some() {
            bump_ttl(&env, &key);
        }
        Ok(info)
    }
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke},
        vec, IntoVal, Val,
    };

    /// 64 bytes — at the limit, must be accepted.
    const ID_64: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    /// 65 bytes — one over, must be rejected.
    const ID_65: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn setup() -> (Env, Address, AgentRegistryClient<'static>) {
        let env = Env::default();
        let contract_id = env.register(AgentRegistry, ());
        let client = AgentRegistryClient::new(&env, &contract_id);
        (env, contract_id, client)
    }

    fn register(env: &Env, client: &AgentRegistryClient, owner: &Address, id: &String, name: &str) {
        client.register(
            owner,
            id,
            &String::from_str(env, name),
            owner,
            &Vec::new(env),
        );
    }

    #[test]
    fn test_register_and_query() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");

        let info = client.register(
            &owner,
            &id,
            &String::from_str(&env, "Test Agent"),
            &owner,
            &Vec::new(&env),
        );
        assert_eq!(info.id, id);
        assert_eq!(info.owner, owner);
        assert!(info.active);
        assert_eq!(info.created_at, info.updated_at);

        let queried = client.query(&id).unwrap();
        assert_eq!(queried.id, id);
    }

    #[test]
    fn test_duplicate_register_rejected() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        register(&env, &client, &owner, &id, "A");

        let res = client.try_register(
            &owner,
            &id,
            &String::from_str(&env, "B"),
            &owner,
            &Vec::new(&env),
        );
        // try_ returns Result<Result<T, T::Error>, Result<E, InvokeError>>
        let err = res
            .err()
            .expect("expected outer error")
            .expect("contract error");
        assert_eq!(err, Error::AlreadyRegistered);

        // Never overwrite: the original record is untouched.
        let info = client.query(&id).unwrap();
        assert_eq!(info.display_name, String::from_str(&env, "A"));
    }

    #[test]
    fn test_mutation_by_non_owner_rejected_without_mock() {
        let (env, cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        register(&env, &client, &owner, &id, "A");

        // Drop all auth mocks: stranger is not authenticated at all.
        env.set_auths(&[]);
        let stranger = Address::generate(&env);
        let res = client.try_update_metadata(
            &stranger,
            &id,
            &String::from_str(&env, "Hacked"),
            &Vec::new(&env),
        );
        assert!(res.is_err(), "unauthenticated caller must be rejected");

        // Now authenticate the stranger for this call only: they pass
        // require_auth() but are not the owner -> NotAuthorized.
        let name = String::from_str(&env, "Hacked");
        let caps = Vec::<String>::new(&env);
        let args: soroban_sdk::Vec<Val> = vec![
            &env,
            stranger.clone().into_val(&env),
            id.clone().into_val(&env),
            name.clone().into_val(&env),
            caps.clone().into_val(&env),
        ];
        let invoke = MockAuthInvoke {
            contract: &cid,
            fn_name: "update_metadata",
            args,
            sub_invokes: &[],
        };
        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &invoke,
        }]);
        let res = client.try_update_metadata(&stranger, &id, &name, &caps);
        let err = res
            .err()
            .expect("expected outer error")
            .expect("contract error");
        assert_eq!(err, Error::NotAuthorized);

        // State unchanged.
        let info = client.query(&id).unwrap();
        assert_eq!(info.display_name, String::from_str(&env, "A"));
    }

    #[test]
    fn test_mutation_by_owner_succeeds_with_scoped_mock() {
        let (env, cid, client) = setup();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        let name_a = String::from_str(&env, "A");
        let name_b = String::from_str(&env, "B");
        let caps = Vec::<String>::new(&env);

        // Scoped mock: only `owner` is authorized, only for `register`.
        let reg_args: soroban_sdk::Vec<Val> = vec![
            &env,
            owner.clone().into_val(&env),
            id.clone().into_val(&env),
            name_a.clone().into_val(&env),
            owner.clone().into_val(&env),
            caps.clone().into_val(&env),
        ];
        let reg_invoke = MockAuthInvoke {
            contract: &cid,
            fn_name: "register",
            args: reg_args,
            sub_invokes: &[],
        };
        env.mock_auths(&[MockAuth {
            address: &owner,
            invoke: &reg_invoke,
        }]);
        client.register(&owner, &id, &name_a, &owner, &caps);

        // Scoped mock: only `owner`, only for `update_metadata`.
        env.set_auths(&[]);
        let upd_args: soroban_sdk::Vec<Val> = vec![
            &env,
            owner.clone().into_val(&env),
            id.clone().into_val(&env),
            name_b.clone().into_val(&env),
            caps.clone().into_val(&env),
        ];
        let upd_invoke = MockAuthInvoke {
            contract: &cid,
            fn_name: "update_metadata",
            args: upd_args,
            sub_invokes: &[],
        };
        env.mock_auths(&[MockAuth {
            address: &owner,
            invoke: &upd_invoke,
        }]);
        let updated = client.update_metadata(&owner, &id, &name_b, &caps);
        assert_eq!(updated.display_name, name_b);

        // And deactivate by the owner.
        env.set_auths(&[]);
        let deact_args: soroban_sdk::Vec<Val> = vec![
            &env,
            owner.clone().into_val(&env),
            id.clone().into_val(&env),
        ];
        let deact_invoke = MockAuthInvoke {
            contract: &cid,
            fn_name: "deactivate",
            args: deact_args,
            sub_invokes: &[],
        };
        env.mock_auths(&[MockAuth {
            address: &owner,
            invoke: &deact_invoke,
        }]);
        assert!(client.deactivate(&owner, &id));
        assert!(!client.query(&id).unwrap().active);
    }

    #[test]
    fn test_id_validation() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);

        // Empty id.
        let empty = String::from_str(&env, "");
        let res = client.try_register(
            &owner,
            &empty,
            &String::from_str(&env, "A"),
            &owner,
            &Vec::new(&env),
        );
        assert_eq!(
            res.err().expect("outer").expect("contract error"),
            Error::IdEmpty
        );

        // 65 bytes -> too long.
        let too_long = String::from_str(&env, ID_65);
        let res = client.try_register(
            &owner,
            &too_long,
            &String::from_str(&env, "A"),
            &owner,
            &Vec::new(&env),
        );
        assert_eq!(
            res.err().expect("outer").expect("contract error"),
            Error::IdTooLong
        );

        // Exactly 64 bytes -> accepted.
        let max = String::from_str(&env, ID_64);
        client.register(
            &owner,
            &max,
            &String::from_str(&env, "A"),
            &owner,
            &Vec::new(&env),
        );
        assert_eq!(client.query(&max).unwrap().id, max);
    }

    #[test]
    fn test_unknown_id_errors() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let missing = String::from_str(&env, "nope");

        let res = client.try_update_metadata(
            &owner,
            &missing,
            &String::from_str(&env, "X"),
            &Vec::new(&env),
        );
        assert_eq!(
            res.err().expect("outer").expect("contract error"),
            Error::NotFound
        );

        let res = client.try_deactivate(&owner, &missing);
        assert_eq!(
            res.err().expect("outer").expect("contract error"),
            Error::NotFound
        );

        // query on an unknown id is Ok(None), not an error.
        assert!(client.query(&missing).is_none());
    }

    #[test]
    fn test_deactivate() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        register(&env, &client, &owner, &id, "Test");

        client.deactivate(&owner, &id);
        let info = client.query(&id).unwrap();
        assert!(!info.active);
        // Tombstone: still readable, metadata preserved.
        assert_eq!(info.display_name, String::from_str(&env, "Test"));
    }
}
