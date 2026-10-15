import assert from 'node:assert/strict';
import pg from 'pg';

const base = 'http://127.0.0.1:4001/api';
let cookie = '';
let disposableInvoiceId = '';
let disposableDraftId = '';
let disposableClientId = '';
let disposableProductId = '';
let checks = 0;
const db = new pg.Client({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:55432/postgres' });
await db.connect();
async function request(path, { method='GET', body, asViewer=false } = {}) {
  const headers = { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type':'application/json' } : {}) };
  const response = await fetch(base + path, { method, headers, ...(body ? { body:JSON.stringify(body) } : {}) });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  const result = response.status===204 ? null : await response.json();
  if (asViewer) return { response, result };
  return { response, result };
}
function expect(ok, message){assert.ok(ok,message);checks++;console.log(`✓ ${message}`)}
async function login(email='owner@invoiceflow.local') {
  const result=await request('/auth/login',{method:'POST',body:{email,password:'InvoiceFlow!2026'}});
  assert.equal(result.response.status,200);return result.result.user;
}

try {
  const health=await fetch(base+'/health');expect(health.ok,'API health endpoint');
  const owner=await login();expect(owner.role==='owner','owner login and secure session cookie');
  expect((await request('/auth/me')).result.user.email===owner.email,'session identity endpoint');
  expect((await request('/dashboard')).response.ok,'dashboard metrics endpoint');
  const clients=(await request('/clients')).result;expect(clients.length>=3,'seeded client list');
  const overdue=(await request('/invoices?status=Overdue')).result.invoices;
  expect(overdue.some(i=>i.invoice_number==='INV-2026-0041'&&i.status==='Overdue'),'overdue invoice status derives from its due date');
  const products=(await request('/products')).result;expect(products.length>=4,'seeded product catalog');
  let productResult=await request('/products',{method:'POST',body:{name:`QA catalog item ${Date.now()}`,description:'API CRUD test',unitPrice:12.5,taxRate:5,unit:'hour'}});
  expect(productResult.response.status===201,'service creation');disposableProductId=productResult.result.id;
  productResult=await request(`/products/${disposableProductId}`,{method:'PATCH',body:{unitPrice:15}});
  expect(productResult.response.status===200&&Number(productResult.result.unit_price)===15,'service update');

  const controller=new AbortController();
  const eventResponse=await fetch(base+'/events',{headers:{cookie},signal:controller.signal});
  expect(eventResponse.ok&&eventResponse.headers.get('content-type')?.includes('text/event-stream'),'authenticated real-time SSE stream');
  const reader=eventResponse.body.getReader();
  const first=await reader.read();expect(new TextDecoder().decode(first.value).includes('retry:'),'live stream opens with reconnect policy');

  let result=await request('/clients',{method:'POST',body:{name:'QA Client',email:'invoiceflow.qa@example.test',company:'QA Studio',phone:'+91 99999 00000',gstin:'',billingAddress:'Pune'}});
  expect(result.response.status===201,'client creation');disposableClientId=result.result.id;
  const eventPromise=reader.read();
  await request(`/clients/${disposableClientId}`,{method:'PATCH',body:{company:'QA Studio Updated'}});
  const event=await Promise.race([eventPromise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('SSE event timeout')),2500))]);
  expect(new TextDecoder().decode(event.value).includes('client.changed'),'client changes publish without a page refresh');
  expect((await request('/clients')).result.some(c=>c.id===disposableClientId&&c.company==='QA Studio Updated'),'client update persists in the collection');
  controller.abort();

  result=await request('/clients',{method:'POST',body:{name:'Q',email:'bad'}});expect(result.response.status===400,'invalid client data rejected with validation error');
  const tomorrow=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
  result=await request('/invoices',{method:'POST',body:{clientId:disposableClientId,dueDate:tomorrow,notes:'Automated CRUD verification',items:[{name:'QA Service',quantity:2,unitPrice:100,taxRate:18}]}});
  expect(result.response.status===201,'invoice creation with server-calculated GST');
  const invoice=result.result;disposableInvoiceId=invoice.id;
  expect(Number(invoice.subtotal)===200&&Number(invoice.tax_total)===36&&Number(invoice.total)===236,'invoice totals computed correctly (₹200 + ₹36 GST)');
  result=await request(`/invoices/${invoice.id}`,{method:'PATCH',body:{status:'Draft',dueDate:tomorrow,notes:'Updated by API smoke test'}});
  expect(result.response.status===200&&result.result.status==='Draft'&&result.result.notes==='Updated by API smoke test','invoice update');
  await request(`/invoices/${invoice.id}`,{method:'PATCH',body:{status:'Sent'}});
  expect((await request(`/invoices?q=${invoice.invoice_number}`)).result.invoices.some(i=>i.id===invoice.id),'invoice search/filter');
  const detail=(await request(`/invoices/${invoice.id}`)).result;expect(detail.items.length===1&&detail.workspace.name,'invoice detail and line items');

  result=await request(`/invoices/${invoice.id}/payments`,{method:'POST',body:{amount:100,method:'UPI',reference:'QA-PARTIAL'}});
  expect(result.response.status===201,'partial payment recorded');
  const partial=(await request(`/invoices/${invoice.id}`)).result;
  expect(partial.status==='Partial'&&Number(partial.balance)===136,'balance and Partial status update');
  result=await request(`/invoices/${invoice.id}/payments`,{method:'POST',body:{amount:137,method:'UPI',reference:'QA-OVER'}});
  expect(result.response.status===400,'overpayment is rejected');
  result=await request(`/invoices/${invoice.id}/payments`,{method:'POST',body:{amount:136,method:'Bank transfer',reference:'QA-FINAL'}});
  expect(result.response.status===201,'final payment recorded');
  const paid=(await request(`/invoices/${invoice.id}`)).result;
  expect(paid.status==='Paid'&&Number(paid.balance)===0&&paid.payments.length===2,'invoice transitions to Paid with zero balance');
  expect((await request(`/invoices/${invoice.id}`,{method:'PATCH',body:{status:'Draft'}})).response.status===409,'paid invoice status cannot be reset after payment');
  expect((await request(`/invoices/${invoice.id}`,{method:'DELETE'})).response.status===409,'paid invoices are protected from deletion');
  expect((await request(`/clients/${disposableClientId}`,{method:'DELETE'})).response.status===409,'clients linked to invoices are protected from deletion');
  const draft=await request('/invoices',{method:'POST',body:{clientId:disposableClientId,dueDate:tomorrow,items:[{name:'QA Deletable',quantity:1,unitPrice:10,taxRate:0}]}});
  expect(draft.response.status===201,'second invoice fixture created');disposableDraftId=draft.result.id;
  expect((await request(`/invoices/${disposableDraftId}`,{method:'DELETE'})).response.status===204,'unpaid invoice deletion');disposableDraftId='';
  expect((await request(`/products/${disposableProductId}`,{method:'DELETE'})).response.status===204,'service archive');

  const viewer=await login('viewer@invoiceflow.local');expect(viewer.role==='viewer','viewer role login');
  result=await request('/clients',{method:'POST',body:{name:'Forbidden Test',email:'forbidden@example.test'},asViewer:true});
  expect(result.response.status===403,'viewer cannot create or mutate data');
  expect((await request('/products',{method:'POST',body:{name:'Forbidden Item',unitPrice:1,taxRate:0},asViewer:true})).response.status===403,'viewer cannot mutate the service catalog');
  expect((await request('/invoices')).response.ok,'viewer can read invoice data');
  await login();
  await db.query('DELETE FROM invoices WHERE id=$1',[disposableInvoiceId]);disposableInvoiceId='';
  await db.query('DELETE FROM clients WHERE id=$1',[disposableClientId]);disposableClientId='';
  await db.query('DELETE FROM products WHERE id=$1',[disposableProductId]);disposableProductId='';
  await request('/auth/logout',{method:'POST'});cookie='';
  expect((await request('/auth/me')).response.status===401,'logout clears the session');
  console.log(`\n${checks} API checks passed; temporary QA rows cleaned up.`);
} catch(error) {
  console.error('\nAPI verification failed:',error);
  if(disposableInvoiceId)await db.query('DELETE FROM invoices WHERE id=$1',[disposableInvoiceId]).catch(()=>{});
  if(disposableDraftId)await db.query('DELETE FROM invoices WHERE id=$1',[disposableDraftId]).catch(()=>{});
  if(disposableClientId)await db.query('DELETE FROM clients WHERE id=$1',[disposableClientId]).catch(()=>{});
  if(disposableProductId)await db.query('DELETE FROM products WHERE id=$1',[disposableProductId]).catch(()=>{});
  process.exitCode=1;
} finally { await db.end(); }
