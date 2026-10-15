import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pool, initializeDatabase } from './db.js';
import { addConnection, keepAlive, publish } from './events.js';

const app=express();
const PORT=Number(process.env.PORT||4000);
const roles=['owner','accountant','viewer'];
const invoiceStatuses=['Draft','Sent','Partial','Paid','Overdue','Void'];
const loginSchema=z.object({email:z.string().email().max(180),password:z.string().min(8).max(128)});
const clientSchema=z.object({name:z.string().trim().min(2).max(120),email:z.string().email().max(180),company:z.string().trim().max(160).default(''),phone:z.string().trim().max(40).default(''),gstin:z.string().trim().max(20).default(''),billingAddress:z.string().trim().max(500).default('')});
const productSchema=z.object({name:z.string().trim().min(2).max(140),description:z.string().trim().max(500).default(''),unitPrice:z.coerce.number().min(0).max(100000000),taxRate:z.coerce.number().min(0).max(100).default(18),unit:z.string().trim().min(1).max(30).default('unit')});
const lineSchema=z.object({productId:z.string().uuid().nullable().optional(),name:z.string().trim().min(2).max(160),quantity:z.coerce.number().positive().max(100000),unitPrice:z.coerce.number().min(0).max(100000000),taxRate:z.coerce.number().min(0).max(100)});
const invoiceSchema=z.object({clientId:z.string().uuid(),dueDate:z.string().date(),notes:z.string().trim().max(2000).default(''),items:z.array(lineSchema).min(1).max(40)});
const invoiceUpdateSchema=z.object({status:z.enum(['Draft','Sent','Void']).optional(),dueDate:z.string().date().optional(),notes:z.string().trim().max(2000).optional()}).refine(value=>Object.keys(value).length>0);
const paymentSchema=z.object({amount:z.coerce.number().positive().max(100000000),method:z.enum(['Bank transfer','UPI','Card','Cash','Other']),reference:z.string().trim().max(120).default('')});
app.disable('x-powered-by');app.use(helmet({crossOriginResourcePolicy:false}));app.use(express.json({limit:'1mb'}));app.use(cookieParser());

const cookieOpts=()=>({httpOnly:true,sameSite:'lax',secure:process.env.COOKIE_SECURE==='true',path:'/',maxAge:7*24*60*60*1000});
function publicUser(user){return{id:user.id,name:user.name,email:user.email,role:user.role,workspaceId:user.workspace_id,workspaceName:user.workspace_name,currency:user.currency,gstin:user.gstin}}
function failValidation(response,error){return response.status(400).json({error:'Please check the submitted fields.',details:error.issues?.map(issue=>({field:issue.path.join('.'),message:issue.message}))})}
function requireAuth(request,response,next){
  try{
    const token=request.cookies.invoiceflow_session;if(!token)return response.status(401).json({error:'Please sign in to continue.'});
    const claims=jwt.verify(token,process.env.JWT_SECRET);
    pool.query('SELECT u.id,u.workspace_id,u.name,u.email,u.role,w.name AS workspace_name,w.currency,w.gstin FROM users u JOIN workspaces w ON w.id=u.workspace_id WHERE u.id=$1 AND u.workspace_id=$2',[claims.sub,claims.workspaceId])
      .then(result=>{if(!result.rowCount)return response.status(401).json({error:'Your account is no longer available.'});request.user=result.rows[0];next()})
      .catch(()=>response.status(401).json({error:'Your session expired. Please sign in again.'}));
  }catch{return response.status(401).json({error:'Your session expired. Please sign in again.'})}
}
function requireEditor(request,response,next){if(!['owner','accountant'].includes(request.user?.role))return response.status(403).json({error:'Owner or accountant access required.'});next()}
function requireOwner(request,response,next){if(request.user?.role!=='owner')return response.status(403).json({error:'Owner access required.'});next()}
function parse(schema,request,response){const result=schema.safeParse(request.body);if(!result.success){failValidation(response,result.error);return null}return result.data}
const invoiceSelect=`SELECT i.id,i.invoice_number,CASE WHEN i.status IN ('Sent','Partial') AND i.due_date<CURRENT_DATE THEN 'Overdue' ELSE i.status END AS status,i.issue_date,i.due_date,i.currency,i.notes,i.subtotal,i.tax_total,i.total,i.created_at,i.updated_at,
  c.id AS client_id,c.name AS client_name,c.company AS client_company,c.email AS client_email,c.gstin AS client_gstin,
  COALESCE(p.paid,0)::numeric AS paid,(i.total-COALESCE(p.paid,0))::numeric AS balance
  FROM invoices i JOIN clients c ON c.id=i.client_id LEFT JOIN LATERAL (SELECT sum(amount) AS paid FROM payments WHERE invoice_id=i.id) p ON true`;
async function addActivity(client,invoiceId,actorId,action,details){await client.query('INSERT INTO invoice_activity(invoice_id,actor_id,action,details) VALUES($1,$2,$3,$4)',[invoiceId,actorId,action,details])}

app.get('/api/health',async(_req,res)=>{try{await pool.query('SELECT 1');res.json({status:'ok',service:'invoiceflow-api'})}catch{res.status(503).json({status:'unavailable'})}});
app.post('/api/auth/login',async(req,res)=>{
  const data=parse(loginSchema,req,res);if(!data)return;
  const result=await pool.query('SELECT u.*,w.name AS workspace_name,w.currency,w.gstin FROM users u JOIN workspaces w ON w.id=u.workspace_id WHERE lower(u.email)=lower($1)',[data.email]);
  const user=result.rows[0];if(!user||!(await bcrypt.compare(data.password,user.password_hash)))return res.status(401).json({error:'Email or password is incorrect.'});
  const token=jwt.sign({sub:user.id,workspaceId:user.workspace_id,role:user.role},process.env.JWT_SECRET,{expiresIn:'7d'});res.cookie('invoiceflow_session',token,cookieOpts()).json({user:publicUser(user)});
});
app.get('/api/auth/me',requireAuth,(req,res)=>res.json({user:publicUser(req.user)}));
app.post('/api/auth/logout',(_req,res)=>res.clearCookie('invoiceflow_session',{...cookieOpts(),maxAge:undefined}).status(204).end());
app.get('/api/events',requireAuth,(req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write('retry: 2500\n\n');const remove=addConnection(res,req.user.workspace_id);res.on('close',remove)});
app.get('/api/dashboard',requireAuth,async(req,res)=>{
  const result=await pool.query(`SELECT
    (SELECT count(*)::int FROM invoices WHERE workspace_id=$1 AND status<>'Void') AS invoice_count,
    (SELECT count(*)::int FROM clients WHERE workspace_id=$1) AS client_count,
    (SELECT COALESCE(sum(total),0)::numeric FROM invoices WHERE workspace_id=$1 AND status='Paid' AND date_trunc('month',issue_date)=date_trunc('month',CURRENT_DATE)) AS revenue_month,
    (SELECT COALESCE(sum(i.total-COALESCE(p.paid,0)),0)::numeric FROM invoices i LEFT JOIN LATERAL (SELECT sum(amount) paid FROM payments WHERE invoice_id=i.id) p ON true WHERE i.workspace_id=$1 AND i.status NOT IN ('Paid','Void')) AS outstanding,
    (SELECT count(*)::int FROM invoices WHERE workspace_id=$1 AND status NOT IN ('Paid','Void') AND due_date<CURRENT_DATE) AS overdue_count`,[req.user.workspace_id]);res.json(result.rows[0]);
});
app.get('/api/clients',requireAuth,async(req,res)=>{const result=await pool.query(`SELECT c.id,c.name,c.email,c.company,c.phone,c.gstin,c.billing_address,c.created_at,count(i.id)::int AS invoice_count FROM clients c LEFT JOIN invoices i ON i.client_id=c.id WHERE c.workspace_id=$1 GROUP BY c.id ORDER BY c.name`,[req.user.workspace_id]);res.json(result.rows)});
app.post('/api/clients',requireAuth,requireEditor,async(req,res)=>{const data=parse(clientSchema,req,res);if(!data)return;try{const result=await pool.query('INSERT INTO clients(workspace_id,name,email,company,phone,gstin,billing_address) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[req.user.workspace_id,data.name,data.email.toLowerCase(),data.company,data.phone,data.gstin,data.billingAddress]);publish(req.user.workspace_id,'client.changed',{clientId:result.rows[0].id,action:'created'});res.status(201).json(result.rows[0])}catch(error){if(error.code==='23505')return res.status(409).json({error:'A client with this email already exists.'});throw error}});
app.patch('/api/clients/:id',requireAuth,requireEditor,async(req,res)=>{const data=parse(clientSchema.partial(),req,res);if(!data||!Object.keys(data).length)return res.status(400).json({error:'Provide client fields to update.'});const fields={name:'name',email:'email',company:'company',phone:'phone',gstin:'gstin',billingAddress:'billing_address'};const sets=[],values=[req.params.id,req.user.workspace_id];for(const[key,value]of Object.entries(data)){values.push(key==='email'?value.toLowerCase():value);sets.push(`${fields[key]}=$${values.length}`)}try{const result=await pool.query(`UPDATE clients SET ${sets.join(',')} WHERE id=$1 AND workspace_id=$2 RETURNING *`,values);if(!result.rowCount)return res.status(404).json({error:'Client not found.'});publish(req.user.workspace_id,'client.changed',{clientId:req.params.id,action:'updated'});res.json(result.rows[0])}catch(error){if(error.code==='23505')return res.status(409).json({error:'A client with this email already exists.'});throw error}});
app.delete('/api/clients/:id',requireAuth,requireOwner,async(req,res)=>{const used=await pool.query('SELECT 1 FROM invoices WHERE client_id=$1 LIMIT 1',[req.params.id]);if(used.rowCount)return res.status(409).json({error:'Clients with invoices cannot be deleted.'});const result=await pool.query('DELETE FROM clients WHERE id=$1 AND workspace_id=$2',[req.params.id,req.user.workspace_id]);if(!result.rowCount)return res.status(404).json({error:'Client not found.'});publish(req.user.workspace_id,'client.changed',{clientId:req.params.id,action:'deleted'});res.status(204).end()});
app.get('/api/products',requireAuth,async(req,res)=>{const result=await pool.query('SELECT id,name,description,unit_price,tax_rate,unit,active FROM products WHERE workspace_id=$1 AND active=true ORDER BY name',[req.user.workspace_id]);res.json(result.rows)});
app.post('/api/products',requireAuth,requireEditor,async(req,res)=>{const data=parse(productSchema,req,res);if(!data)return;try{const result=await pool.query('INSERT INTO products(workspace_id,name,description,unit_price,tax_rate,unit) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,description,unit_price,tax_rate,unit,active',[req.user.workspace_id,data.name,data.description,data.unitPrice,data.taxRate,data.unit]);publish(req.user.workspace_id,'product.changed',{productId:result.rows[0].id,action:'created'});res.status(201).json(result.rows[0])}catch(error){if(error.code==='23505')return res.status(409).json({error:'A product with this name already exists.'});throw error}});
app.patch('/api/products/:id',requireAuth,requireEditor,async(req,res)=>{const data=parse(productSchema.partial(),req,res);if(!data||!Object.keys(data).length)return res.status(400).json({error:'Provide product fields to update.'});const fields={name:'name',description:'description',unitPrice:'unit_price',taxRate:'tax_rate',unit:'unit'};const sets=[],values=[req.params.id,req.user.workspace_id];for(const[key,value]of Object.entries(data)){values.push(value);sets.push(`${fields[key]}=$${values.length}`)}try{const result=await pool.query(`UPDATE products SET ${sets.join(',')} WHERE id=$1 AND workspace_id=$2 AND active=true RETURNING id,name,description,unit_price,tax_rate,unit,active`,values);if(!result.rowCount)return res.status(404).json({error:'Product not found.'});publish(req.user.workspace_id,'product.changed',{productId:req.params.id,action:'updated'});res.json(result.rows[0])}catch(error){if(error.code==='23505')return res.status(409).json({error:'A product with this name already exists.'});throw error}});
app.delete('/api/products/:id',requireAuth,requireOwner,async(req,res)=>{const result=await pool.query('UPDATE products SET active=false WHERE id=$1 AND workspace_id=$2 AND active=true',[req.params.id,req.user.workspace_id]);if(!result.rowCount)return res.status(404).json({error:'Product not found.'});publish(req.user.workspace_id,'product.changed',{productId:req.params.id,action:'archived'});res.status(204).end()});
app.get('/api/invoices',requireAuth,async(req,res)=>{
  const filters=['i.workspace_id=$1'],values=[req.user.workspace_id];
  if(req.query.status&&invoiceStatuses.includes(req.query.status)){if(req.query.status==='Overdue'){filters.push("i.status IN ('Sent','Partial') AND i.due_date<CURRENT_DATE")}else{values.push(req.query.status);filters.push(`i.status=$${values.length}${['Sent','Partial'].includes(req.query.status)?' AND i.due_date>=CURRENT_DATE':''}`)}}
  if(req.query.q){values.push(`%${String(req.query.q).slice(0,100)}%`);filters.push(`(i.invoice_number ILIKE $${values.length} OR c.name ILIKE $${values.length} OR c.company ILIKE $${values.length})`)}
  const result=await pool.query(`${invoiceSelect} WHERE ${filters.join(' AND ')} ORDER BY i.issue_date DESC,i.created_at DESC LIMIT 100`,values);res.json({invoices:result.rows});
});
app.post('/api/invoices',requireAuth,requireEditor,async(req,res)=>{
  const data=parse(invoiceSchema,req,res);if(!data)return;
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const customer=(await client.query('SELECT id FROM clients WHERE id=$1 AND workspace_id=$2',[data.clientId,req.user.workspace_id])).rows[0];if(!customer){await client.query('ROLLBACK');return res.status(400).json({error:'Choose a client from this workspace.'})}
    let subtotal=0,taxTotal=0;const lines=data.items.map(item=>{const lineSubtotal=Math.round(item.quantity*item.unitPrice*100)/100,lineTax=Math.round(lineSubtotal*item.taxRate)/100;subtotal+=lineSubtotal;taxTotal+=lineTax;return{...item,lineSubtotal,lineTax,lineTotal:lineSubtotal+lineTax}});
    const counter=(await client.query('INSERT INTO invoice_counters(workspace_id,year,last_number) VALUES($1,EXTRACT(YEAR FROM CURRENT_DATE)::int,1) ON CONFLICT(workspace_id,year) DO UPDATE SET last_number=invoice_counters.last_number+1 RETURNING year,last_number',[req.user.workspace_id])).rows[0];
    const invoiceNumber=`INV-${counter.year}-${String(counter.last_number).padStart(4,'0')}`;
    const created=(await client.query(`INSERT INTO invoices(workspace_id,client_id,invoice_number,status,due_date,currency,notes,subtotal,tax_total,total,created_by)
      VALUES($1,$2,$3,'Sent',$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[req.user.workspace_id,data.clientId,invoiceNumber,data.dueDate,req.user.currency,data.notes,subtotal,taxTotal,subtotal+taxTotal,req.user.id])).rows[0];
    for(const line of lines)await client.query('INSERT INTO invoice_items(invoice_id,product_id,name,quantity,unit_price,tax_rate,line_subtotal,line_tax,line_total) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[created.id,line.productId||null,line.name,line.quantity,line.unitPrice,line.taxRate,line.lineSubtotal,line.lineTax,line.lineTotal]);
    await addActivity(client,created.id,req.user.id,'created','Invoice created');await client.query('COMMIT');
    const invoice=(await client.query(`${invoiceSelect} WHERE i.id=$1`,[created.id])).rows[0];publish(req.user.workspace_id,'invoice.changed',{invoiceId:created.id,action:'created'});res.status(201).json(invoice);
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}
});
app.get('/api/invoices/:id',requireAuth,async(req,res)=>{
  const invoice=(await pool.query(`${invoiceSelect} WHERE i.id=$1 AND i.workspace_id=$2`,[req.params.id,req.user.workspace_id])).rows[0];if(!invoice)return res.status(404).json({error:'Invoice not found.'});
  const items=await pool.query('SELECT id,product_id,name,quantity,unit_price,tax_rate,line_subtotal,line_tax,line_total FROM invoice_items WHERE invoice_id=$1 ORDER BY id',[invoice.id]);
  const payments=await pool.query('SELECT p.id,p.amount,p.method,p.reference,p.paid_at,u.name AS recorded_by FROM payments p LEFT JOIN users u ON u.id=p.recorded_by WHERE p.invoice_id=$1 ORDER BY p.paid_at DESC',[invoice.id]);
  const activity=await pool.query('SELECT a.action,a.details,a.created_at,u.name AS actor_name FROM invoice_activity a LEFT JOIN users u ON u.id=a.actor_id WHERE a.invoice_id=$1 ORDER BY a.created_at DESC LIMIT 20',[invoice.id]);
  res.json({...invoice,items:items.rows,payments:payments.rows,activity:activity.rows,workspace:{name:req.user.workspace_name,gstin:req.user.gstin}});
});
app.patch('/api/invoices/:id',requireAuth,requireEditor,async(req,res)=>{
  const data=parse(invoiceUpdateSchema,req,res);if(!data)return;
  const before=(await pool.query('SELECT id,status FROM invoices WHERE id=$1 AND workspace_id=$2',[req.params.id,req.user.workspace_id])).rows[0];if(!before)return res.status(404).json({error:'Invoice not found.'});
  if(data.status&&data.status!==before.status){const paid=(await pool.query('SELECT COALESCE(sum(amount),0)::numeric AS total FROM payments WHERE invoice_id=$1',[before.id])).rows[0];if(Number(paid.total)>0)return res.status(409).json({error:'Invoice status cannot change after a payment is recorded.'})}
  const client=await pool.connect();try{await client.query('BEGIN');const result=await client.query('UPDATE invoices SET status=COALESCE($3,status),due_date=COALESCE($4,due_date),notes=COALESCE($5,notes),updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING id',[before.id,req.user.workspace_id,data.status||null,data.dueDate||null,Object.hasOwn(data,'notes')?data.notes:null]);await addActivity(client,before.id,req.user.id,'updated','Invoice details updated');await client.query('COMMIT');const invoice=(await client.query(`${invoiceSelect} WHERE i.id=$1`,[result.rows[0].id])).rows[0];publish(req.user.workspace_id,'invoice.changed',{invoiceId:before.id,action:'updated'});res.json(invoice)}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}
});
app.delete('/api/invoices/:id',requireAuth,requireOwner,async(req,res)=>{const paid=(await pool.query('SELECT COALESCE(sum(amount),0)::numeric AS total FROM payments WHERE invoice_id=$1',[req.params.id])).rows[0];if(Number(paid?.total)>0)return res.status(409).json({error:'Invoices with payments cannot be deleted; void them instead.'});const result=await pool.query('DELETE FROM invoices WHERE id=$1 AND workspace_id=$2',[req.params.id,req.user.workspace_id]);if(!result.rowCount)return res.status(404).json({error:'Invoice not found.'});publish(req.user.workspace_id,'invoice.changed',{invoiceId:req.params.id,action:'deleted'});res.status(204).end()});
app.post('/api/invoices/:id/payments',requireAuth,requireEditor,async(req,res)=>{
  const data=parse(paymentSchema,req,res);if(!data)return;
  const client=await pool.connect();try{
    await client.query('BEGIN');const invoice=(await client.query('SELECT id,total,status FROM invoices WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[req.params.id,req.user.workspace_id])).rows[0];if(!invoice){await client.query('ROLLBACK');return res.status(404).json({error:'Invoice not found.'})}if(invoice.status==='Void'){await client.query('ROLLBACK');return res.status(409).json({error:'Cannot record payment for a void invoice.'})}
    const paid=Number((await client.query('SELECT COALESCE(sum(amount),0)::numeric AS total FROM payments WHERE invoice_id=$1',[invoice.id])).rows[0].total);const remaining=Number(invoice.total)-paid;if(data.amount>remaining+0.005){await client.query('ROLLBACK');return res.status(400).json({error:`Payment exceeds the remaining balance of ₹${remaining.toFixed(2)}.`})}
    const payment=(await client.query('INSERT INTO payments(invoice_id,amount,method,reference,recorded_by) VALUES($1,$2,$3,$4,$5) RETURNING id,amount,method,reference,paid_at',[invoice.id,data.amount,data.method,data.reference,req.user.id])).rows[0];const newPaid=paid+data.amount;const status=newPaid>=Number(invoice.total)-0.005?'Paid':'Partial';await client.query('UPDATE invoices SET status=$2,updated_at=now() WHERE id=$1',[invoice.id,status]);await addActivity(client,invoice.id,req.user.id,'payment',`Payment received · ₹${Number(data.amount).toFixed(2)}`);await client.query('COMMIT');publish(req.user.workspace_id,'invoice.changed',{invoiceId:invoice.id,action:'payment'});res.status(201).json(payment);
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}
});
app.use((error,_req,res,_next)=>{console.error(error);if(res.headersSent)return;res.status(500).json({error:'Something went wrong. Please try again.'})});
async function start(){if(!process.env.JWT_SECRET||process.env.JWT_SECRET.length<32)throw new Error('Set JWT_SECRET to a random secret with at least 32 characters in .env');await initializeDatabase();app.listen(PORT,'127.0.0.1',()=>console.log(`InvoiceFlow API listening on http://127.0.0.1:${PORT}`));setInterval(keepAlive,20000).unref()}
start().catch(error=>{console.error(error);process.exitCode=1});
