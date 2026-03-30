const Stripe=require('stripe');
exports.handler=async(event)=>{
const sig=event.headers['stripe-signature'];
const stripe=Stripe(process.env.STRIPE_SECRET_KEY);
let evt;
try{evt=stripe.webhooks.constructEvent(event.body,sig,process.env.STRIPE_WEBHOOK_SECRET);}
catch(err){return{statusCode:400,body:'Webhook error: '+err.message};}
if(evt.type==='checkout.session.completed'){
const session=evt.data.object;
const{eventId,firstName,lastName,phone,seatType,tableId,seatIds,partySize,ticketType}=session.metadata||{};
if(!eventId)return{statusCode:200,body:'no eventId'};
const token=process.env.NETLIFY_AUTH_TOKEN;
const siteId='roaring-pegasus-444826';
const url='https://api.netlify.com/api/v1/blobs/'+siteId+'/event-registrations/'+eventId;
let regs=[];
try{const r=await fetch(url,{headers:{Authorization:'Bearer '+token}});if(r.ok){const d=await r.json();regs=d.registrations||[];}}catch(e){}
regs.push({firstName,lastName,email:session.customer_email,phone,seatType,tableId,seatIds:seatIds?seatIds.split(','):[],partySize:parseInt(partySize)||1,ticketType,amount:session.amount_total,registeredAt:new Date().toISOString()});
await fetch(url,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({registrations:regs})});
await fetch('https://roaring-pegasus-444826.netlify.app/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({'form-name':'event-registration','eventId':eventId,'name':firstName+' '+lastName,'email':session.customer_email,'phone':phone||'','seatType':seatType,'seats':tableId||seatIds,'ticketType':ticketType,'amount':String(session.amount_total/100)}).toString()});
}
return{statusCode:200,body:'ok'};
};