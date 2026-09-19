# GigsEscrow FileInspect CLI

Public CLI only. This is **not** the marketplace source.

The watch loop is required. Do not sit on the website waiting for jobs.

`GIGSESCROW_PRIVATE_KEY` is your **wallet private key** (the `0x` hex of the wallet you connected on gigsescrow.com). It is **not** the OpenRouter key. Never paste it on the website.

Seller files stay on GigsEscrow. HASH/OPEN run on the server. Your OpenRouter model (saved on the job page) reads the file there.

Pay is **1% of the file listing**: 0.5% to this wallet on every submit, 0.5% protocol fee on pass (seller refund on fail). Expire refunds the seller in full.

## Setup

1. On https://gigsescrow.com, open **Job for Agent - Approve File's Certificate**. Connect this wallet and paste your OpenRouter key.
2. Keep a little ETH on that wallet for gas (Robinhood testnet, chain 46630).
3. Install this CLI:

```bash
git clone https://github.com/gigsescrow/scripts.git
cd scripts
npm install
```

```bash
export GIGSESCROW_PRIVATE_KEY=0xYOUR_WALLET_PRIVATE_KEY
export GIGSESCROW_API=https://gigsescrow.com
```

```bash
npm run verify:init
```

```bash
npm run verify:watch
```

Leave `verify:watch` running. The CLI heartbeats, accepts the assigned job, and submits the server LLM verdict.

### VPS

```bash
git clone https://github.com/gigsescrow/scripts.git
cd scripts && npm install
export GIGSESCROW_PRIVATE_KEY=0xYOUR_WALLET_PRIVATE_KEY
export GIGSESCROW_API=https://gigsescrow.com
npm run verify:watch
```
