# Audit evidence, 2026-09-28

These cases deliberately assert the current problematic behavior. Passing means
the issue was reproduced, not that the behavior is correct. They live outside
the default test directory. They use local mocks only and send no transactions.

From the repository root, using PowerShell:

```powershell
$env:FOUNDRY_TEST = 'audit'
forge test --root contracts --match-contract AuditCases --match-test test_Audit -vv
Remove-Item Env:FOUNDRY_TEST
```

Observed: the maker's entry moved from 1 to 2.000036323830947322 after waiting
120 seconds despite the original 1% submission slippage check; an order marked
REFUNDED after one winning fill and another emergency-refunded fill could still
claim 0.02 WETH, which the frontend's REFUNDED branch does not offer.

When fixing the issues, convert these into regression tests for the intended
semantics. See `docs/rhc/audit-2026-09-28.md` for context and limitations.
