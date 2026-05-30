const { SorobanRpc } = require('@stellar/stellar-sdk');
const db = require('../db');
const logger = require('../utils/logger');

// Soroban RPC endpoint — separate from Horizon
const rpcUrl = process.env.SOROBAN_RPC_URL;

// Comma-separated list of deployed contract IDs to index
const contractIds = process.env.SOROBAN_CONTRACT_IDS
  ? process.env.SOROBAN_CONTRACT_IDS.split(',').map((s) => s.trim()).filter(Boolean)
  : [];

// Ledger cursor persisted in DB so we resume after restarts
const CURSOR_KEY = 'contract_event_indexer_cursor';

async function getCursor() {
  const { rows } = await db.query(
    `SELECT value FROM indexer_cursors WHERE key = $1`,
    [CURSOR_KEY]
  );
  return rows[0]?.value || null;
}

async function saveCursor(ledger) {
  await db.query(
    `INSERT INTO indexer_cursors (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [CURSOR_KEY, String(ledger)]
  );
}

async function indexContractEvents() {
  if (!rpcUrl) {
    logger.warn('SOROBAN_RPC_URL not set — skipping contract event indexer');
    return;
  }
  if (contractIds.length === 0) {
    logger.debug('SOROBAN_CONTRACT_IDS not set — no contracts to index');
    return;
  }

  const rpc = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });

  let startLedger;
  try {
    const cursor = await getCursor();
    if (cursor) {
      startLedger = parseInt(cursor, 10);
    } else {
      // Bootstrap: start from the latest ledger
      const latest = await rpc.getLatestLedger();
      startLedger = latest.sequence;
      await saveCursor(startLedger);
      logger.info('Contract event indexer bootstrapped', { startLedger });
      return;
    }
  } catch (err) {
    logger.error('Contract event indexer: failed to read cursor', { error: err.message });
    return;
  }

  try {
    const response = await rpc.getEvents({
      startLedger,
      filters: contractIds.map((contractId) => ({
        type: 'contract',
        contractIds: [contractId],
      })),
    });

    if (!response.events || response.events.length === 0) {
      // Advance cursor to latest so next run doesn't re-scan the same range
      const latest = await rpc.getLatestLedger();
      if (latest.sequence > startLedger) await saveCursor(latest.sequence);
      return;
    }

    let maxLedger = startLedger;

    for (const event of response.events) {
      const ledger = event.ledger;
      if (ledger > maxLedger) maxLedger = ledger;

      const eventName = event.topic?.[0]?.value ?? 'unknown';
      const contractId = event.contractId;
      const txHash = event.txHash;
      const payload = JSON.stringify(event.value ?? {});

      try {
        await db.query(
          `INSERT INTO contract_events (contract_id, event_name, tx_hash, ledger, payload, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (tx_hash, event_name) DO NOTHING`,
          [contractId, eventName, txHash, ledger, payload]
        );
        logger.debug('Indexed contract event', { contractId, eventName, txHash, ledger });
      } catch (err) {
        logger.error('Failed to persist contract event', { txHash, eventName, error: err.message });
      }
    }

    await saveCursor(maxLedger + 1);
    logger.info('Contract events indexed', { count: response.events.length, nextLedger: maxLedger + 1 });
  } catch (err) {
    logger.error('Contract event indexer: getEvents failed', { error: err.message });
  }
}

module.exports = { indexContractEvents };
