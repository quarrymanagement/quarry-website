const Stripe=require('stripe');
exports.handler=async(event)=>{
  const stripe=Stripe(process.env.STRIPE_SECRET_KEY);
  let evt;
  try{evt=stripe.webhooks.constructEvent(event.body,event.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET);}
  catch(err){return{statusCode:400,body:'Signature error'};}
  if(evt.type==='checkout.session.completed'){
    const session=evt.data.object;
    const m=session.metadata||{};
    const token=process.env.NETLIFY_AUTH_TOKEN;
    const siteId='roaring-pegasus-444826';
    if(m.eventId){
      const url='https://api.netlify.com/api/v1/blobs/'+siteId+'/event-registrations/'+m.eventId;
      let regs=[];
      try{const r=await fetch(url,{headers:{Authorization:'Bearer '+token}});if(r.ok){const d=await r.json();regs=d.registrations||[];}}catch(e){}
      regs.push({firstName:m.firstName,lastName:m.lastName,email:session.customer_email||session.customer_details?.email||'',phone:m.phone,seatType:m.seatType,tableId:m.tableId||null,seatIds:(m.seatIds||'').split(',').filter(Boolean),partySize:parseInt(m.partySize)||1,ticketType:m.ticketType||'base',amount:session.amount_total,registeredAt:new Date().toISOString()});
      await fetch(url,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({registrations:regs})});
    }
  }
  return{statusCode:200,body:JSON.stringify({received:true})};
};