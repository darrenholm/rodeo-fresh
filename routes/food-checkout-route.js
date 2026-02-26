// ============================================
// POST /api/moneris/food-checkout
// Create Moneris checkout for food orders (phone-based)
// ============================================
// ADD THIS to your existing routes/moneris.js file, inside the module.exports function
// Place it after the merch-checkout route

router.post('/food-checkout', async (req, res) => {
  try {
    const { items, customerName, customerEmail, subtotal, tax, total, taxLabel } = req.body;

    if (!items || items.length === 0 || !customerName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const orderId = `FOOD-${Date.now()}`;
    const orderNumber = String(Math.floor(Math.random() * 90) + 10); // 2-digit order number

    // Store the food order in database
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS food_orders (
          id SERIAL PRIMARY KEY,
          order_id VARCHAR(50) UNIQUE NOT NULL,
          order_number VARCHAR(10),
          customer_name VARCHAR(100),
          customer_email VARCHAR(100),
          items JSONB,
          subtotal NUMERIC(10,2),
          tax NUMERIC(10,2),
          total NUMERIC(10,2),
          status VARCHAR(20) DEFAULT 'pending',
          payment_status VARCHAR(20) DEFAULT 'pending',
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      await pool.query(
        `INSERT INTO food_orders (order_id, order_number, customer_name, customer_email, items, subtotal, tax, total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [orderId, orderNumber, customerName, customerEmail || '', JSON.stringify(items), subtotal, tax, total]
      );

      // Also create kitchen order so it shows on kitchen display
      try {
        // Auto-create kitchen_orders table if not exists
        await pool.query(`
          CREATE TABLE IF NOT EXISTS kitchen_orders (
            id SERIAL PRIMARY KEY,
            order_number VARCHAR(10) NOT NULL,
            customer_name VARCHAR(100) DEFAULT 'Guest',
            items JSONB NOT NULL DEFAULT '[]',
            subtotal NUMERIC(8,2) DEFAULT 0,
            tax NUMERIC(8,2) DEFAULT 0,
            total NUMERIC(8,2) DEFAULT 0,
            status VARCHAR(20) DEFAULT 'new',
            source VARCHAR(20) DEFAULT 'kiosk',
            payment_status VARCHAR(20) DEFAULT 'pending',
            payment_ref VARCHAR(100),
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            completed_at TIMESTAMPTZ,
            picked_up_at TIMESTAMPTZ
          )
        `);

        const kitchenItems = items.map(i => ({
          name: i.name,
          qty: i.quantity || i.qty || 1,
          price: i.price,
          emoji: i.emoji || ''
        }));

        await pool.query(
          `INSERT INTO kitchen_orders (order_number, customer_name, items, subtotal, tax, total, source, payment_ref, payment_status)
           VALUES ($1, $2, $3, $4, $5, $6, 'phone', $7, 'pending')`,
          [orderNumber, customerName, JSON.stringify(kitchenItems), subtotal, tax, total, orderId]
        );
        console.log(`[food-checkout] Kitchen order #${orderNumber} created for ${customerName}`);
      } catch (kitchenErr) {
        console.warn('[food-checkout] Kitchen order insert note:', kitchenErr.message);
      }
    } catch (dbErr) {
      console.log('[food-checkout] DB insert note:', dbErr.message);
    }

    const { storeId, apiToken, checkoutId } = getMonerisCredentials();

    const ticket = await monerisPreload({
      store_id: storeId,
      api_token: apiToken,
      checkout_id: checkoutId,
      txn_total: total.toFixed(2),
      cart_subtotal: subtotal.toFixed(2),
      tax: {
        amount: tax.toFixed(2),
        description: taxLabel || 'HST',
        rate: '13.00'
      },
      environment: 'prod',
      action: 'preload',
      order_no: orderId,
      cust_id: customerEmail || customerName,
      contact_details: {
        email: customerEmail || '',
        first_name: customerName.split(' ')[0] || customerName,
        last_name: customerName.split(' ').slice(1).join(' ') || ''
      }
    });

    const appUrl = process.env.APP_URL || 'https://holmdalerodeo.ca';
    const successUrl = `${appUrl}/FoodOrder?success=true&order=${orderNumber}`;

    console.log(`✓ Moneris food checkout: ${orderId}, ${items.length} items, $${total.toFixed(2)}`);

    res.json({
      ticket,
      orderId,
      orderNumber,
      url: `https://gateway.moneris.com/chktv2/index.php?ticket=${ticket}&redirect=${encodeURIComponent(successUrl)}`
    });

  } catch (error) {
    console.error('Food checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});
