const nodemailer = require('nodemailer');
const db = require('../db');
const webhook = require('../services/webhook');
const logger = require('../utils/logger');

// How many hours before expiry to send a warning notification
const WARN_HOURS = parseInt(process.env.CLAIMABLE_BALANCE_WARN_HOURS || '24', 10);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function notifyUser(userId, balanceId, expiresAt) {
  if (!process.env.SMTP_HOST) return;
  try {
    const { rows } = await db.query('SELECT email, full_name FROM users WHERE id = $1', [userId]);
    if (!rows[0]) return;
    const { email, full_name } = rows[0];
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: 'AfriPay: Claimable balance expiring soon',
      html: `<p>Hi ${full_name},</p>
             <p>Your claimable balance <strong>${balanceId}</strong> will expire on
             <strong>${new Date(expiresAt).toUTCString()}</strong>.</p>
             <p>Please claim it before it expires to avoid losing the funds.</p>`,
    });
    logger.info('Expiry notification sent', { userId, balanceId });
  } catch (err) {
    logger.warn('Failed to send expiry notification email', { userId, balanceId, error: err.message });
  }
}

async function checkClaimableBalanceExpiry() {
  // 1. Mark balances that have already expired
  const { rows: expired } = await db.query(
    `UPDATE claimable_balances
     SET status = 'expired', updated_at = NOW()
     WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()
     RETURNING id, balance_id, user_id, asset, amount`
  );

  for (const row of expired) {
    logger.info('Claimable balance expired', { balanceId: row.balance_id });
    webhook.deliver('claimable_balance.expired', {
      id: row.id,
      balance_id: row.balance_id,
      asset: row.asset,
      amount: row.amount,
    }).catch(() => {});
  }

  // 2. Warn about balances expiring within WARN_HOURS
  const { rows: expiringSoon } = await db.query(
    `SELECT id, balance_id, user_id, asset, amount, expires_at
     FROM claimable_balances
     WHERE status = 'active'
       AND expires_at IS NOT NULL
       AND expires_at > NOW()
       AND expires_at <= NOW() + ($1 || ' hours')::interval`,
    [WARN_HOURS]
  );

  for (const row of expiringSoon) {
    webhook.deliver('claimable_balance.expiring_soon', {
      id: row.id,
      balance_id: row.balance_id,
      asset: row.asset,
      amount: row.amount,
      expires_at: row.expires_at,
    }).catch(() => {});

    if (row.user_id) {
      await notifyUser(row.user_id, row.balance_id, row.expires_at);
    }
  }

  if (expired.length > 0 || expiringSoon.length > 0) {
    logger.info('Claimable balance expiry check complete', {
      expired: expired.length,
      expiringSoon: expiringSoon.length,
    });
  }
}

module.exports = { checkClaimableBalanceExpiry };
