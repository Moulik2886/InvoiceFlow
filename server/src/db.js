import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const localPGlite = process.env.DATABASE_URL?.includes('127.0.0.1:5432');
export const pool = new pg.Pool({ connectionString:process.env.DATABASE_URL, max:Number(process.env.DB_POOL_SIZE || (localPGlite ? 1 : 10)) });
const here = path.dirname(fileURLToPath(import.meta.url));

export async function initializeDatabase() {
  await pool.query(await fs.readFile(path.join(here,'../sql/schema.sql'),'utf8'));
  if ((await pool.query('SELECT id FROM workspaces LIMIT 1')).rowCount) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const workspace=(await client.query("INSERT INTO workspaces(name,currency,gstin) VALUES('Northstar Studio','INR','24AAACN1234F1Z5') RETURNING id")).rows[0];
    const demo=[
      ['Maya Shah','owner@invoiceflow.local','owner'],
      ['Aarav Mehta','accounts@invoiceflow.local','accountant'],
      ['Riya Patel','viewer@invoiceflow.local','viewer']
    ];
    const users={};
    for(const [name,email,role] of demo){
      const passwordHash=await bcrypt.hash('InvoiceFlow!2026',10);
      users[role]=(await client.query('INSERT INTO users(workspace_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5) RETURNING id',[workspace.id,name,email,passwordHash,role])).rows[0].id;
    }
    const clients=[];
    for(const item of [
      ['Acme Design Co.','finance@acmedesign.example','Mumbai','27AABCU9603R1ZM'],
      ['BrightPath Labs','accounts@brightpath.example','Pune','27AAFCB7781K1ZP'],
      ['Fieldnote Media','billing@fieldnote.example','Ahmedabad','24AABCF2156D1Z4']
    ]) clients.push((await client.query('INSERT INTO clients(workspace_id,name,email,company,gstin,billing_address) VALUES($1,$2,$3,$2,$4,$5) RETURNING id',[workspace.id,item[0],item[1],item[3],item[2]])).rows[0].id);
    const products=[];
    for(const item of [
      ['Product design sprint','Research, flows, and interface design',85000,18,'project'],
      ['Frontend development','React implementation and QA',120000,18,'project'],
      ['Strategy workshop','Half-day planning workshop',30000,18,'session'],
      ['Monthly support','Product support and maintenance',45000,18,'month']
    ]) products.push((await client.query('INSERT INTO products(workspace_id,name,description,unit_price,tax_rate,unit) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[workspace.id,...item])).rows[0].id);
    const today=new Date();
    const date=(offset)=>{const d=new Date(today);d.setDate(d.getDate()+offset);return d.toISOString().slice(0,10)};
    const seeds=[
      {number:'INV-2026-0042',client:clients[0],status:'Sent',issue:date(-3),due:date(11),items:[[products[0],'Product design sprint',1,85000,18],[products[2],'Strategy workshop',1,30000,18]]},
      {number:'INV-2026-0041',client:clients[1],status:'Partial',issue:date(-12),due:date(-2),items:[[products[1],'Frontend development',1,120000,18]],payment:50000},
      {number:'INV-2026-0040',client:clients[2],status:'Paid',issue:date(-25),due:date(-10),items:[[products[3],'Monthly support',2,45000,18]],payment:106200}
    ];
    for(const seed of seeds){
      const calc=seed.items.reduce((a,x)=>{const base=x[2]*x[3];return {sub:a.sub+base,tax:a.tax+base*x[4]/100}}, {sub:0,tax:0});
      const total=calc.sub+calc.tax;
      const invoice=(await client.query('INSERT INTO invoices(workspace_id,client_id,invoice_number,status,issue_date,due_date,subtotal,tax_total,total,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',[workspace.id,seed.client,seed.number,seed.status,seed.issue,seed.due,calc.sub,calc.tax,total,users.owner])).rows[0];
      for(const [productId,name,qty,price,tax] of seed.items){const sub=qty*price, lineTax=sub*tax/100;await client.query('INSERT INTO invoice_items(invoice_id,product_id,name,quantity,unit_price,tax_rate,line_subtotal,line_tax,line_total) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[invoice.id,productId,name,qty,price,tax,sub,lineTax,sub+lineTax]);}
      await client.query('INSERT INTO invoice_activity(invoice_id,actor_id,action,details) VALUES($1,$2,$3,$4)',[invoice.id,users.owner,'created','Invoice created']);
      if(seed.payment)await client.query('INSERT INTO payments(invoice_id,amount,method,reference,recorded_by) VALUES($1,$2,$3,$4,$5)',[invoice.id,seed.payment,seed.status==='Paid'?'Bank transfer':'UPI','DEMO-TRANSFER',users.owner]);
    }
    await client.query('INSERT INTO invoice_counters(workspace_id,year,last_number) VALUES($1,$2,42)',[workspace.id,new Date().getFullYear()]);
    await client.query('COMMIT');
    console.log('Seeded InvoiceFlow demo workspace.');
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
