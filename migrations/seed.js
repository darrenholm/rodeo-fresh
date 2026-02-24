const fs = require('fs');
const csv = require('csv-parser');
const pool = require('../config/database');

/**
 * Import CSV data into PostgreSQL database
 * This script imports all 7 CSV files from Base44 export
 */

async function importCSV(filePath, tableName, transformRow = row => row) {
  return new Promise((resolve, reject) => {
    const rows = [];
    
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        rows.push(transformRow(row));
      })
      .on('end', async () => {
        console.log(`Processing ${rows.length} rows for ${tableName}...`);
        
        for (const row of rows) {
          try {
            const columns = Object.keys(row);
            const values = Object.values(row);
            const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
            
            const query = `
              INSERT INTO ${tableName} (${columns.join(', ')})
              VALUES (${placeholders})
              ON CONFLICT (id) DO UPDATE SET
              ${columns.filter(c => c !== 'id').map(c => `${c} = EXCLUDED.${c}`).join(', ')}
            `;
            
            await pool.query(query, values);
          } catch (error) {
            console.error(`Error inserting row into ${tableName}:`, error.message);
          }
        }
        
        console.log(`✓ Imported ${rows.length} rows into ${tableName}`);
        resolve();
      })
      .on('error', reject);
  });
}

// Transform functions for each table
const transformers = {
  staff: (row) => ({
    id: row.id,
    no: parseInt(row.no) || null,
    fname: row.fname || null,
    lname: row.lname || null,
    fullname: row.fullname || null,
    email: row.email === 'NULL' || !row.email ? null : row.email,
    phone: row.phone === 'NULL' || !row.phone ? null : row.phone,
    adult: row.adult === 'TRUE',
    smartserve: row.smartserve === 'TRUE',
    y2024: row.y2024 === 'TRUE',
    y2025: row.y2025 === 'TRUE',
    y2026: row.y2026 === 'TRUE' || row.y2026 === 'NULL',
    y2027: row.y2027 === 'TRUE' || row.y2027 === 'NULL',
    y2028: row.y2028 === 'TRUE' || row.y2028 === 'NULL',
    created_date: row.created_date,
    updated_date: row.updated_date,
    created_by_id: row.created_by_id,
    created_by: row.created_by,
    is_sample: row.is_sample === 'true'
  }),
  
  events: (row) => ({
    id: row.id,
    title: row.title,
    date: row.date,
    time: row.time || null,
    description: row.description || null,
    image_url: row.image_url || null,
    venue: row.venue || null,
    general_price: parseFloat(row.general_price) || 0,
    vip_price: parseFloat(row.vip_price) || 0,
    general_available: parseInt(row.general_available) || 0,
    vip_available: parseInt(row.vip_available) || 0,
    is_featured: row.is_featured === 'true',
    created_date: row.created_date,
    updated_date: row.updated_date,
    created_by_id: row.created_by_id,
    created_by: row.created_by,
    is_sample: row.is_sample === 'true'
  }),
  
  shifts: (row) => ({
    id: row.id,
    staff_name: row.staff_name,
    staff_id: null, // Will need to be linked manually or via script
    date: row.date,
    start_time: row.start_time,
    end_time: row.end_time,
    role: row.role || null,
    notes: row.notes || null,
    event_id: row.event_id || null,
    created_date: row.created_date,
    updated_date: row.updated_date,
    created_by_id: row.created_by_id,
    created_by: row.created_by,
    is_sample: row.is_sample === 'true'
  }),
  
  ticket_orders: (row) => ({
    id: row.id,
    event_id: row.event_id || null,
    customer_name: row.customer_name,
    customer_email: row.customer_email,
    customer_phone: row.customer_phone || null,
    ticket_type: row.ticket_type || 'general',
    quantity_adult: parseInt(row.quantityAdult) || 0,
    quantity_child: parseInt(row.quantityChild) || 0,
    total_price: parseFloat(row.total_price) || 0,
    confirmation_code: row.confirmation_code || null,
    status: row.status || 'pending',
    scanned: row.scanned === 'true',
    scanned_at: row.scanned_at || null,
    rfid_tag_id: row.rfid_tag_id || null,
    created_date: row.created_date,
    updated_date: row.updated_date,
    created_by_id: row.created_by_id,
    created_by: row.created_by,
    is_sample: row.is_sample === 'true'
  }),
  
  products: (row) => ({
    id: row.id,
    name: row.name,
    description: row.description || null,
    category: row.category || null,
    price: parseFloat(row.price) || 0,
    image_url: row.image_url || null,
    stripe_price_id: row.stripe_price_id || null,
    sizes: row.sizes || '[]',
    colors: row.colors || '[]',
    stock: parseInt(row.stock) || 0,
    weight: parseFloat(row.weight) || null,
    length: parseFloat(row.length) || null,
    width: parseFloat(row.width) || null,
    height: parseFloat(row.height) || null,
    created_date: row.created_date,
    updated_date: row.updated_date,
    created_by_id: row.created_by_id,
    created_by: row.created_by,
    is_sample: row.is_sample === 'true'
  }),
  
  orders: (row) => ({
    id: row.id,
    stripe_session_id: row.stripe_session_id || null,
    monaris_transaction_id: row.monaris_transaction_id || null,
    customer_name: row.customer_name,
    customer_email: row.customer_email,
    items: row.items || '[]',
    total_amount: parseFloat(row.total_amount) || 0,
    shipping_address: row.shipping_address || null,
    tracking_number: row.tracking_number || null,
    shipment_id: row.shipment_id || null,
    status: row.status || 'pending',
    created_date: row.created_date,
    updated_date: row.updated_date,
    created_by_id: row.created_by_id,
    created_by: row.created_by,
    is_sample: row.is_sample === 'true'
  })
};

async function main() {
  try {
    console.log('Starting CSV import...\n');
    
    // Import in order (respecting foreign key dependencies)
    await importCSV('./data/Staff.csv', 'staff', transformers.staff);
    await importCSV('./data/Event.csv', 'events', transformers.events);
    await importCSV('./data/Shift.csv', 'shifts', transformers.shifts);
    await importCSV('./data/TicketOrder.csv', 'ticket_orders', transformers.ticket_orders);
    await importCSV('./data/Product.csv', 'products', transformers.products);
    await importCSV('./data/Order.csv', 'orders', transformers.orders);
    
    console.log('\n✓ All data imported successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Import failed:', error);
    process.exit(1);
  }
}

main();
