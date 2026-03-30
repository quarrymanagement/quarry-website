const Stripe=require('stripe');
exports.handler=async(event)=>{
const headers={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
if(event.httpMethod==='OPTIONS')return{statusCode:200,headers,body:''};
if(event.httpMethod!=='POST')return{statusCode:405,headers,body:'Method not allowed'};
try{
const{eventId,firstName,lastName,email,phone,seatType,tableId,seatIds,partySize,ticketType}=JSON.parse(event.body||'{}');
if(!eventId||!firstName||!email||!seatType)return{statusCode:400,headers,body:JSON.stringify({error:'Missing required fields'})};
const token=process.env.NETLIFY_AUTH_TOKEN;
const siteId='roaring-pegasus-444826';
const stripe=Stripe(process.env.STRIPE_SECRET_KEY);
const evRes=await fetch('https://api.netlify.com/api/v1/blobs/'+siteId+'/quarry-events/'+eventId,{headers:{Authorization:'Bearer '+token}});
if(!evRes.ok)return{statusCode:404,headers,body:JSON.stringify({error:'Event not found'})};
const ev=await evRes.json();
let regs=[];
try{const rr=await fetch('https://api.netlify.com/api/v1/blobs/'+siteId+'/event-registrations/'+eventId,{headers:{Authorization:'Bearer '+token}});if(rr.ok){const d=await rr.json();regs=d.registrations||[];}}catch(e){}
const takenTables=regs.filter(r=>r.seatType==='table').map(r=>r.tableId);
const takenBar=regs.filter(r=>r.seatType==='bar').flatMap(r=>r.seatIds||[]);
if(seatType==='table'&&takenTables.includes(tableId))return{statusCode:409,headers,body:JSON.stringify({error:'Table already reserved'})};
if(seatType==='bar'&&(seatIds||[]).some(s=>takenBar.includes(s)))return{statusCode:409,headers,body:JSON.stringify({error:'One or more seats already taken'})};
const qty=seatType==='table'?(ev.tableSize||6):(partySize||1);
const price=ticketType==='premium'?ev.pricePremium:ev.priceBase;
const session=await stripe.checkout.sessions.create({
payment_method_types:['card'],mode:'payment',allow_promotion_codes:true,
line_items:[{price_data:{currency:'usd',product_data:{name:ev.title+(seatType==='table'?' — Table '+tableId:' — Bar Seat(s)'),description:ticketType==='premium'?'Bottomless Mimosa/Bloody Mary + Brunch + Bingo':'Brunch + Bingo'},unit_amount:Math.round(price*100)},quantity:qty}],
customer_email:email,
metadata:{eventId,firstName,lastName,phone:phone||'',seatType,tableId:tableId||'',seatIds:(seatIds||[]).join(','),partySize:String(qty),ticketType:ticketType||'base'},
success_url:'https://roaring-pegasus-444826.netlify.app/quarry-events?registered=1&event='+eventId,
cancel_url:'https://roaring-pegasus-444826.netlify.app/quarry-events'
});
return{statusCode:200,headers,body:JSON.stringify({checkoutUrl:session.url})};
}catch(err){return{statusCode:500,headers,body:JSON.stringify({error:err.message})};}
};