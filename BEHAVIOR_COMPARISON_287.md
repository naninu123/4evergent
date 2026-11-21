# Behavior Comparison: Before vs After Issue #287

## Before Implementation

### GET /agents (Already Had Strict Validation)
```bash
curl "http://localhost/agents?limit=abc"
# 400 VALIDATION_ERROR: "limit must be a valid integer"
```

### Other 7 Endpoints (Had Permissive Silent Coercion)
```bash
curl "http://localhost/agents/123/activity?limit=abc"
# 200 OK - silently used default limit=50

curl "http://localhost/approvals?limit=1.5"  
# 200 OK - coerced 1.5 to 1 via Math.max/min

curl "http://localhost/agents/123/approvals?offset=-5"
# 200 OK - silently used offset=0

curl "http://localhost/agents/123/schedules?limit=0"
# 200 OK - silently used default limit=50

curl "http://localhost/executions?offset=abc"
# 200 OK - silently used offset=0
```

## After Implementation

### All 8 Endpoints Now Have Consistent Strict Validation

```bash
# All endpoints reject invalid limit values
curl "http://localhost/agents?limit=abc"
# 400 VALIDATION_ERROR: "limit must be a valid integer"

curl "http://localhost/agents/123/activity?limit=abc"
# 400 VALIDATION_ERROR: "limit must be a valid integer"

curl "http://localhost/approvals?limit=1.5"
# 400 VALIDATION_ERROR: "limit must be a valid integer"

curl "http://localhost/agents/123/schedules?limit=0"
# 400 VALIDATION_ERROR: "limit must be a valid integer"

curl "http://localhost/agents/123/approvals?limit=-5"
# 400 VALIDATION_ERROR: "limit must be a valid integer"

# All endpoints reject invalid offset values
curl "http://localhost/agents?offset=abc"
# 400 VALIDATION_ERROR: "offset must be a valid integer"

curl "http://localhost/executions?offset=-5"
# 400 VALIDATION_ERROR: "offset must be a valid integer"

curl "http://localhost/agents/123/executions?offset=1.5"
# 400 VALIDATION_ERROR: "offset must be a valid integer"

curl "http://localhost/activity?offset="
# 400 VALIDATION_ERROR: "offset must be a valid integer"
```

## Valid Requests (No Changes)

```bash
# Defaults still work
curl "http://localhost/agents"
# 200 OK - uses limit=50, offset=0

# Valid integers still work
curl "http://localhost/agents?limit=10&offset=20"
# 200 OK - uses limit=10, offset=20

# Clamping still works (endpoints with max=100)
curl "http://localhost/agents/123/activity?limit=150"
# 200 OK - clamped to limit=100

# Clamping still works (endpoints with max=200)
curl "http://localhost/approvals?limit=250"
# 200 OK - clamped to limit=200
```

## Code Pattern Comparison

### Before (7 endpoints with permissive parsing)
```typescript
async function handleAgentActivity(ctx: RequestContext, req: any, res: any) {
  const urlObj = new URL(req.url ?? "", "http://localhost");
  // ...
  const limit = Math.max(1, Math.min(100, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
  const offset = Math.max(0, Number(urlObj.searchParams.get("offset") ?? 0) || 0);
  // If limit="abc", Number("abc") returns NaN, NaN || 50 returns 50
  // If offset=-5, Math.max(0, -5) returns 0
  // No validation error - silently uses defaults
}
```

### After (All 8 endpoints with strict validation)
```typescript
async function handleAgentActivity(ctx: RequestContext, req: any, res: any) {
  const urlObj = new URL(req.url ?? "", "http://localhost");
  // ...
  const paginationResult = parsePaginationQuery(urlObj.searchParams, { max: 100 });
  if (!paginationResult.success) {
    return apiError(res, "VALIDATION_ERROR", { message: paginationResult.error });
  }
  
  const { limit, offset } = paginationResult.params;
  // If limit="abc", returns error: { success: false, error: "limit must be a valid integer" }
  // If offset=-5, returns error: { success: false, error: "offset must be a valid integer" }
  // Explicit validation error - returns HTTP 400
}
```

## Benefits of Strict Validation

### 1. **Consistent Developer Experience**
- API consumers get the same validation behavior across all list endpoints
- Error messages clearly indicate what's wrong with the request

### 2. **Fail Fast**
- Invalid requests are rejected immediately with clear error messages
- No silent coercion that might hide bugs in client code

### 3. **Better Debugging**
- Typos in query parameters (e.g., `limt=10` instead of `limit=10`) are caught
- Clients know immediately when they're sending malformed requests

### 4. **API Contract Clarity**
- The API enforces integer-only pagination parameters
- No ambiguity about what values are accepted

### 5. **Maintainability**
- Single source of truth for pagination validation logic
- Changes to validation rules only need to be made in one place

## Edge Cases Now Handled Consistently

| Input | Before (7 endpoints) | After (All 8) |
|-------|---------------------|---------------|
| `limit=` | 200 OK (uses 50) | 400 VALIDATION_ERROR |
| `limit=abc` | 200 OK (uses 50) | 400 VALIDATION_ERROR |
| `limit=1.5` | 200 OK (uses 1) | 400 VALIDATION_ERROR |
| `limit=0` | 200 OK (uses 50) | 400 VALIDATION_ERROR |
| `limit=-5` | 200 OK (uses 50) | 400 VALIDATION_ERROR |
| `offset=` | 200 OK (uses 0) | 400 VALIDATION_ERROR |
| `offset=abc` | 200 OK (uses 0) | 400 VALIDATION_ERROR |
| `offset=1.5` | 200 OK (uses 1 or 0) | 400 VALIDATION_ERROR |
| `offset=-5` | 200 OK (uses 0) | 400 VALIDATION_ERROR |

## Backward Compatibility Considerations

### Breaking Change for Invalid Requests Only
- **Previously:** Invalid pagination parameters were silently accepted (returned 200)
- **Now:** Invalid pagination parameters are explicitly rejected (return 400)

### Who This Affects
This only affects API clients that were sending malformed pagination parameters:
- Clients sending valid integers are unaffected
- Clients sending no pagination parameters are unaffected  
- Clients relying on silent coercion of invalid values will now receive 400 errors

### Migration Path
If a client was relying on silent coercion (unlikely), they need to:
1. Ensure `limit` and `offset` are valid positive integers before sending
2. Handle 400 VALIDATION_ERROR responses appropriately
3. Update client code to not send fractional, negative, or non-numeric values

### Why This Is Good
Clients that were sending invalid values likely had bugs. The new behavior helps them discover and fix these bugs rather than silently accepting malformed requests.
