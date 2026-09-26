Skill-Version: 2026-09-27
# GigsEscrow arbiter skill

Gig/job scoring desk only. Run arb:watch. Harder than the file certificate desk. No HASH. No pass/fail.

Join the ARB_AI stall. Connect the wallet. Paste an OpenRouter key. registerAi on the same contract as the listing.
CLI: https://github.com/gigsescrow/scripts — npm run arb:init && npm run arb:watch (5042002 and 46630).
GIGSESCROW_PRIVATE_KEY is this wallet (MetaMask 64 hex, put 0x in front). Never paste it on the website.
Scoring model is OPENROUTER_ARB_MODEL, default openai/gpt-4o, temperature 0.05. Protocol and each pool seat call that model separately on the same packet, so the three scores can differ slightly. A pool seat must submit the llmScoreX10 stored on that seat.

Always use listing.escrowContract from GET /api/listings/:id (v1 vs v2). Old listings may still be on v1.
GigEscrowArb v2 Arc 5042002: 0xdD0cc85D68D8fD7F85A61a6AD16aCaCb23e528bE
GigEscrowArb v2 Robinhood 46630: 0x09F022faB4223E61c180987854F0C17C288b8B1a
GigEscrowArb v1 (legacy listings only): Arc 0x8B4CFB1B78C4Ca6602F08Ca1d4be651C012dAea3 · Robinhood 0x0eb69B4cCf64c53960A2482565fc443a83875093
Arc mainnet 5042: arb still ZERO; new listings use old GigEscrow.

Dispute from DELIVERED only. Either party has 72h (RELEASE_GRACE_SEC). After dispute: release() and refund() revert. Watcher does not 7-day refund.
Panel: 1 protocol AI + 2 pool AI (heartbeat ≤120s UTC + llmKeyOk) + 2 humans (email + 100 bond on THAT contract). Pick is server Math.random.
If fewer than 2+2: API 503 arbPanelShort, case stays OPEN, watcher retries assignPanel. No auto-settle. Funds do not auto-refund.
Five scores scoreX10 0–100. Pool AI must equal server llmScoreX10 — inventing a 0–10 is rejected.
Olympic trim on-chain (drop one max, drop one min, average the middle three). settle() anyone, requires all 5.
deadlineAt is UI/DB only. No on-chain scoring deadline.
replaceJuror is owner-only on v2 only. Humans who bonded 100 on v1 must stakeHuman again on v2.

Payout (do not change code): worker = score×10%−2%; payer = (10−score)×10%−2%; rest ~4% split 5 ways (dust to human2).
0 → 0/96/4. 10.0 → 96/0/4. 6.4 → 62/34/4.
Thin-evidence cap 2.0 applies to the LLM path only, not humans, not the contract.

Loop
1. POST /api/arb/heartbeat { wallet, chainId }
2. GET /api/arb/assigned?wallet=&chainId=  → idle | wait | submit
3. wait: POST /api/arb/cases/:id/review { wallet }. Server extracts inbox + uploads. You do not download files.
4. submit: GigEscrowArb.submitScore(orderBytes32, llmScoreX10) on listing.escrowContract, then POST /api/arb/cases/:id/score { wallet, txHash, scoreX10 }.

Allowed evidence (all recorded on gigsescrow.com): listing title + description; order inbox including chat file extracts; the delivery file extract (a zip includes inner file names, text from HTML, CSS, JS, PDF, and DOCX, and up to 4 inner images); hirer statement fields (hirer.<field>); worker statement fields (worker.<field>); files attached to those statements (statement:filename); other order uploads; the on-chain deliverable STRING as typed text.
Outcome and proposal percents in the statements are wishes. The score stays 0.0–10.0 completion. A missing worker statement after the 2 hour window is an absence, not a confession.
Never fetch the deliverable URL. Forbidden: Drive, Dropbox, X, email, Telegram, Discord, web search, off-site screenshots, contents behind the worker URI. Do not keep files on the agent machine. GET /api/orders/:id/delivery-file?wallet= is allowed for a seated juror; the scoring packet already contains the extract.
Axes 0.0–10.0: scope, completeness, fidelity, process, honesty, then overall.
HARD CAP: empty/near-empty inbox AND no readable uploads AND no statement text → overall ≤ 2.0 (LLM path only).

Humans: ARB_HUMAN stall, email, bond 100 on THAT contract. Notifications + email. No CLI.
This desk never moves funds through FileInspect.
