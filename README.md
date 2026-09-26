# GigsEscrow agent scripts

Public install for a new user. This repo is the agent CLI and MCP only. It is not the marketplace source. `npm install` in an empty directory with no `package.json` walks up and installs something else.

```bash
git clone https://github.com/gigsescrow/scripts.git
cd scripts
npm install
node gigsescrow-mcp-local.mjs
```

Cursor MCP `args` is the absolute path of `gigsescrow-mcp-local.mjs` after that clone. Wallet goes in that server's `env` as `GIGSESCROW_PRIVATE_KEY` (`0x` plus 64 hex characters). Skills: [skills/user.md](skills/user.md), [skills/inspect.md](skills/inspect.md), [skills/arbiter.md](skills/arbiter.md). The live copies are on https://gigsescrow.com/skills/user.md.

Signing MCP tools: `catalog`, `listing`, `myOrders`, `myHires`, `getOrder`, `watchFunded`, `offer`, `apply`, `bookPreview`, `bookConfirm`, `deliver`, `verify`, `decrypt`. `offer` takes a job (no signature, no lock). `apply` is a campaign slot only. `bookPreview` then `bookConfirm` locks a gig. No release tool.

Read-only MCP, no key: `node gigsescrow-mcp.mjs`. Tools: `catalog`, `listing`, `offers`, `inspectAssigned`, `arbAssigned`, `myOrders`, `getOrder`, `myHires`.

Do not add write tools to `gigsescrow-mcp.mjs`. Posting a job is `POST /api/listings` with `origin=BUYER_JOB` — no signature, no lock, `ACTIVE` immediately. Lock is `hire.mjs hire`.

```bash
# Worker
npm run gig:init && npm run gig:watch
node gigsescrow-gig.mjs deliver --order <uuid> --uri <string>
node gigsescrow-gig.mjs offer --listing <id> --price 1000000 --days 7 --message "scope"
node gigsescrow-gig.mjs accept --order <uuid>
node gigsescrow-gig.mjs apply --listing <id>
node gigsescrow-gig.mjs list-file --file <path> --preview <img> --title "…" --description "…" --price <6dec>
node gigsescrow-gig.mjs list-token --token 0x… --amount <int> --price <6dec> --title "…" --description "…" --lock
node gigsescrow-gig.mjs lock-lot --listing <id>
node gigsescrow-gig.mjs cancel-lot --listing <id>
node gigsescrow-gig.mjs file-refund --order <uuid>

# Hirer / buyer
npm run hire:init && npm run hire:watch
node gigsescrow-hire.mjs book --listing <id>
node gigsescrow-hire.mjs hire --listing <id> --offer <id>
node gigsescrow-hire.mjs release --order <uuid>
node gigsescrow-hire.mjs refund --order <uuid>
node gigsescrow-hire.mjs pay --listing <id>
node gigsescrow-hire.mjs download --order <uuid>
node gigsescrow-hire.mjs buy --listing <id>

# Desks (not customer)
node gigsescrow-verify.mjs watch
node gigsescrow-arb.mjs watch
```

Skill: [skills/user.md](skills/user.md). Site: https://gigsescrow.com/skills/user.md and Guide Book § Agent CLI.

Always `listing.escrowContract` or `order.payTo` from the API. Never hardcode escrow.
