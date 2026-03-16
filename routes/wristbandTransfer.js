// ============================================
// WRISTBAND TRANSFER ROUTES
// Handles drink ticket transfers between wristbands
// ============================================

module.exports = function(pool) {
  const express = require('express');
  const router = express.Router();

  // ============================================
  // GET /api/wristbands/balance/:uid
  // Public endpoint — check balance by NFC UID (no auth needed for kiosk)
  // ============================================
  router.get('/balance/:uid', async (req, res) => {
    try {
      const uid = req.params.uid.toUpperCase();
      const result = await pool.query(
        `SELECT id, rfid_uid, customer_name, credits, credits_spent, 
                alcohol_approved, ticket_order_id, created_date
         FROM wristbands 
         WHERE UPPER(rfid_uid) = $1`,
        [uid]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Wristband not found' });
      }

      const w = result.rows[0];
      res.json({
        id: w.id,
        rfid_uid: w.rfid_uid,
        customer_name: w.customer_name,
        credits: w.credits || 0,
        credits_spent: w.credits_spent || 0,
        remaining: Math.max(0, parseFloat(w.credits) || 0),
        alcohol_approved: w.alcohol_approved || false,
        registered: w.created_date
      });
    } catch (error) {
      console.error('Balance lookup error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // POST /api/wristbands/transfer
  // Transfer drink tickets between wristbands
  // Requires: sender_uid, recipient_uid, amount
  // Recipient MUST be alcohol_approved (19+)
  // ============================================
  router.post('/transfer', async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { sender_uid, recipient_uid, amount } = req.body;

      if (!sender_uid || !recipient_uid || !amount || amount < 1) {
        return res.status(400).json({ error: 'Missing required fields: sender_uid, recipient_uid, amount' });
      }

      if (sender_uid.toUpperCase() === recipient_uid.toUpperCase()) {
        return res.status(400).json({ error: 'Cannot transfer to yourself' });
      }

      const qty = parseInt(amount);
      if (isNaN(qty) || qty < 1) {
        return res.status(400).json({ error: 'Invalid amount' });
      }

      await client.query('BEGIN');

      // Lock both wristbands to prevent race conditions
      const senderResult = await client.query(
        `SELECT id, rfid_uid, customer_name, credits, credits_spent, alcohol_approved
         FROM wristbands 
         WHERE UPPER(rfid_uid) = $1
         FOR UPDATE`,
        [sender_uid.toUpperCase()]
      );

      if (senderResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Sender wristband not found' });
      }

      const sender = senderResult.rows[0];
      const senderRemaining = (sender.credits || 0) - (sender.credits_spent || 0);

      if (senderRemaining < qty) {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          error: 'Insufficient tickets', 
          remaining: senderRemaining,
          requested: qty 
        });
      }

      const recipientResult = await client.query(
        `SELECT id, rfid_uid, customer_name, credits, credits_spent, alcohol_approved
         FROM wristbands 
         WHERE UPPER(rfid_uid) = $1
         FOR UPDATE`,
        [recipient_uid.toUpperCase()]
      );

      if (recipientResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Recipient wristband not found' });
      }

      const recipient = recipientResult.rows[0];

      // CHECK 19+ REQUIREMENT
      if (!recipient.alcohol_approved) {
        await client.query('ROLLBACK');
        return res.status(403).json({ 
          error: 'Recipient is not 19+ verified',
          message: 'Drink tickets can only be transferred to age-verified (19+) wristbands.'
        });
      }

      // EXECUTE TRANSFER
      // 1. Deduct from sender (increase credits_spent)
      const newSenderSpent = (sender.credits_spent || 0) + qty;
      await client.query(
        'UPDATE wristbands SET credits_spent = $1 WHERE id = $2',
        [newSenderSpent, sender.id]
      );

      // 2. Add to recipient (increase credits)
      const newRecipientCredits = (recipient.credits || 0) + qty;
      await client.query(
        'UPDATE wristbands SET credits = $1 WHERE id = $2',
        [newRecipientCredits, recipient.id]
      );

      // 3. Log the transfer in bar_transactions
      const txId1 = `transfer_out_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const txId2 = `transfer_in_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      try {
        await client.query(
          `INSERT INTO bar_transactions (id, wristband_id, amount, transaction_type, description, created_by)
           VALUES ($1, $2, $3, 'transfer_out', $4, 'transfer')`,
          [txId1, sender.id, -qty, `Transferred ${qty} ticket(s) to ${recipient.customer_name || recipient.rfid_uid}`]
        );

        await client.query(
          `INSERT INTO bar_transactions (id, wristband_id, amount, transaction_type, description, created_by)
           VALUES ($1, $2, $3, 'transfer_in', $4, 'transfer')`,
          [txId2, recipient.id, qty, `Received ${qty} ticket(s) from ${sender.customer_name || sender.rfid_uid}`]
        );
      } catch (txErr) {
        console.log('Transfer transaction log note:', txErr.message);
      }

      await client.query('COMMIT');

      console.log(`✓ Transfer: ${qty} ticket(s) from ${sender.customer_name || sender.rfid_uid} → ${recipient.customer_name || recipient.rfid_uid}`);

      res.json({
        success: true,
        transfer: {
          amount: qty,
          from: {
            name: sender.customer_name || 'Guest',
            uid: sender.rfid_uid,
            remaining: senderRemaining - qty
          },
          to: {
            name: recipient.customer_name || 'Guest',
            uid: recipient.rfid_uid,
            new_balance: (recipient.credits || 0) + qty - (recipient.credits_spent || 0)
          }
        }
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Transfer error:', error);
      res.status(500).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  // ============================================
  // POST /api/wristbands/:id/add-credits
  // Add credits to a wristband (used by transfer, admin top-up)
  // ============================================
  router.post('/:id/add-credits', async (req, res) => {
    try {
      const { id } = req.params;
      const { amount, source, sender_name } = req.body;

      if (!amount || amount < 1) {
        return res.status(400).json({ error: 'Invalid amount' });
      }

      const result = await pool.query(
        `UPDATE wristbands 
         SET credits = credits + $1
         WHERE id = $2
         RETURNING id, rfid_uid, customer_name, credits, credits_spent, alcohol_approved`,
        [parseInt(amount), id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Wristband not found' });
      }

      // Log transaction
      try {
        const txId = `credit_add_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await pool.query(
          `INSERT INTO bar_transactions (id, wristband_id, amount, transaction_type, description, created_by)
           VALUES ($1, $2, $3, 'credit_add', $4, $5)`,
          [txId, id, parseInt(amount), `Added ${amount} credit(s) via ${source || 'manual'}`, sender_name || 'system']
        );
      } catch (txErr) {
        console.log('Credit add transaction log note:', txErr.message);
      }

      const w = result.rows[0];
      res.json({
        success: true,
        credits: w.credits,
        remaining: w.credits - (w.credits_spent || 0)
      });

    } catch (error) {
      console.error('Add credits error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};
