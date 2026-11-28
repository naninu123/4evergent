# Remaining useApiResource Migration Candidates

This document lists pages that still use the old manual fetch/error/loading pattern and could benefit from migrating to the shared `useApiResource` hook introduced in Issue #75.

## Completed Migrations (Issue #75)

✅ **Activity.tsx** — Initial page load now uses `useApiResource` (hybrid: manual pagination preserved)  
✅ **ActivityDetail.tsx** — Fully migrated to `useApiResource`  
✅ **AgentDetail.tsx** — Main agent + activity fetch migrated to `useApiResource`

## Remaining Migration Candidates

The following pages still use manual state management for API fetching and would benefit from using `useApiResource` in future work:

### High Priority (Simple Patterns)

1. **ApprovalDetail.tsx**
   - **Pattern**: Simple detail fetch with loading/error/data state + reloadKey trigger
   - **Effort**: Low — straightforward migration similar to ActivityDetail
   - **Benefits**: Removes duplicate state management, adds stale request protection

2. **ExecutionDetail.tsx**
   - **Pattern**: Single resource fetch with loading/error state
   - **Effort**: Low — already follows a clean pattern
   - **Benefits**: Consistency with other detail pages

3. **Agents.tsx**
   - **Pattern**: Custom `load()` function with pagination via `listAllAgents()`
   - **Effort**: Low-Medium — straightforward but includes agent creation modal
   - **Benefits**: Would standardize the initial agents list fetch

### Medium Priority (Pagination Patterns)

4. **Approvals.tsx**
   - **Pattern**: Pagination with `loadPage` callback (similar to Activity.tsx before migration)
   - **Effort**: Medium — would need hybrid approach like Activity.tsx
   - **Notes**: Current implementation uses pagination which extends beyond simple initial fetch

5. **Executions.tsx**
   - **Pattern**: Pagination + separate queue summary fetch
   - **Effort**: Medium — has two parallel initial fetches (executions list + queue status)
   - **Benefits**: Could use `useApiResource` for both fetches independently

6. **ScheduleList.tsx**
   - **Pattern**: Pagination with `loadPage` callback
   - **Effort**: Medium — similar to Approvals
   - **Notes**: Currently used as a component within AgentDetail

### Lower Priority (Complex/Special Cases)

7. **Overview.tsx**
   - **Pattern**: Multiple parallel fetches (health, agents, approvals, activity, attention counts)
   - **Effort**: High — would need multiple `useApiResource` calls or a composite pattern
   - **Benefits**: Each resource fetch could use the hook independently

8. **AgentDetail.tsx** — Partial (additional work)
   - **Pattern**: Still has separate `PolicySettings` and `PolicySummary` components with manual fetch
   - **Effort**: Low — `PolicySettings` and `PolicySummary` have their own useEffect-based fetches
   - **Benefits**: Full consistency within the page

9. **Submit.tsx**
   - **Pattern**: Initial agents list fetch, but primary focus is mutation not resource loading
   - **Effort**: Low — only the agents list fetch applies
   - **Notes**: This page is primarily a form submission handler; migration has limited benefit

### Not Applicable

The following pages/components do not follow the fetch/error/loading pattern or don't fetch resources on mount:

- **ExecutionList.tsx** — Component that receives `agentId` prop and fetches, similar to ScheduleList
- **ScheduleManagement.tsx** — Primarily a form for creating/editing schedules, minimal resource fetch

## Recommended Next Steps

**Phase 2 (High Value, Low Effort)**:
- Migrate `ApprovalDetail.tsx`
- Migrate `ExecutionDetail.tsx`
- Migrate `Agents.tsx` (initial list fetch only)

**Phase 3 (Pagination Patterns)**:
- Design a pagination-aware pattern or utility that works with `useApiResource`
- Migrate `Approvals.tsx`, `Executions.tsx`, `ScheduleList.tsx` once pattern is established

**Phase 4 (Complex Cases)**:
- Migrate `Overview.tsx` with multiple independent `useApiResource` calls
- Complete `AgentDetail.tsx` by migrating `PolicySettings` and `PolicySummary`

## Migration Guidelines

When migrating additional pages:

1. **Preserve existing behavior** — UI, loading states, error handling must remain unchanged
2. **Use stable fetcher functions** — wrap fetchers with `useCallback` when they depend on props/state
3. **Handle dependencies correctly** — pass all relevant dependencies to `useApiResource`
4. **Keep pagination separate** — `useApiResource` handles initial load; pagination can remain manual (hybrid approach as shown in Activity.tsx)
5. **Test thoroughly** — ensure stale requests and unmounting are handled correctly
6. **Update existing tests** — verify that page tests still pass after migration

## Notes

- The `useApiResource` hook was designed for simple initial resource loading
- For pagination, use a hybrid approach: `useApiResource` for initial load, manual state for load-more
- Pages with complex multi-step flows or mutations may not benefit significantly from this hook
- The hook's primary value is eliminating duplicated loading/error/data state and providing stale request protection
