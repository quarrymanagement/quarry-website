const Stripe=require('stripe');
exports.handler=async(event)=>{
  const sig=event.headers['stripe-signature'];
  const stripe=Stripe(process.env.STRIPE_SECRET_KEY);
  let evt;
  try{evt=stripe.webhooks.constructEvent(event.body,sig,process.env.STRIPE_WEBHOOK_SECRET);}
  catch(err){return{statusCode:400,body:'Webhook Error: '+err.message};}
  if(evt.type==='checkout.session.completed'){
    const session=evt.data.object;
    const{eventId,name,email,phone,partySize,seatType,tableId,barSeats}=session.metadata||{};
    if(!eventId)return{statusCode:200,body:'No eventId'};
    const token=process.env.NETLIFY_AUTH_TOKEN;
    const siteId='roaring-pegasus-444826';
    let registrations=[];
    try{const r=await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quarry-registrations/event-${eventId}`,{headers:{Authorization:'Bearer '+token}});if(r.ok){const d=await r.json();registrations=d.registrations||[];}}catch(e){}
    registrations.push({name,email,phone,partySize:parseInt(partySize)||1,seatType,tableId:tableId||null,barSeats:barSeats?barSeats.split(',').filter(Boolean):[],stripeSessionId:session.id,amountPaid:session.amount_total,registeredAt:new Date().toISOString()});
    await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quarry-registrations/event-${eventId}`,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({registrations})});
    try{await fetch(`https://${siteId}.netlify.app/`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({'form-name':'event-registration',eventId,name,email,phone:phone||'',partySize:partySize||'1',seatType,tableId:tableId||'',barSeats:barSeats||'',amountPaid:(session.amount_total/100).toFixed(2)}).toString()});}catch(e){}
  }
  return{statusCode:200,body:JSON.stringify({received:true})};
};