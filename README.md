# Volo

Describe an onchain action in plain English. Volo turns it into a fixed rule, shows exactly what it understood, and after you approve it in your wallet, a smart contract holds the permission and a worker runs it on schedule within limits the contract enforces.

> "Every Friday send $10 to my savings wallet when my balance is above $100."

**Status: unaudited testnet prototype** on Arbitrum Sepolia. Test tokens only. Do not use funds you cannot afford to lose.

The AI only turns text into a form. It never has spending power, never sees wallets or keys, and its answer is checked against what you actually wrote before you ever see it. The contract re-checks every run. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together.

## Try it

1. Open the site and connect a wallet (Arbitrum Sepolia, with a little test ETH and test USDC).
2. **Settings:** save a recipient, for example `savings`. Only addresses you save can ever receive money from your rules.
3. **Automate:** describe a rule in the chat, review it, and approve it in your wallet.
4. **Dashboard:** watch it, pause it, or cancel it.

The **Welcome** page has the same steps with a live checklist.

## Run it yourself

Needs Node 22. Copy `.env.example` to `.env` and fill it in (settings are listed in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

```bash
cd backend  && npm install
cd frontend && npm install
cd frontend && npm run build && npm run start    # the website, http://localhost:3000
cd backend  && npm run worker                    # the scheduler (a second terminal)
cd backend  && npm run check                     # checks your settings without sending anything
```

Always start the website with `npm run build` / `npm run start`; they load the root `.env`. A plain `next start` does not.

## Host it

The repo includes a `Dockerfile` that runs the website and the worker in one container (`scripts/start-hosted.sh`). It works on any Docker host. For hosts with no persistent disk, such as a free Render web service, use Supabase for storage: create a project, run `supabase/schema.sql` in its SQL editor, and set `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. `GET /api/health` tells you if storage, the executor wallet and the AI reader are healthy.

## Tests

```bash
cd contracts && forge test
cd backend  && npm test
bash scripts/sync-shared.sh --check
cd frontend && npm run build
```

## Layout

`contracts/` the Solidity contract and its tests · `backend/` logic, scheduler and tests · `frontend/` Next.js app and API routes · `supabase/` database tables · `scripts/` helpers · `docs/` architecture.
