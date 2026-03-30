const Stripe=require('stripe');const{getStore}=require('@netlify/blobs');
exports.handler=async(event,context)=>{
  const stripe=Stripe(process.env.STRIPE_SECRET_KEY);
  let evt;
  try{evt=stripe.webhooks.constructEvent(event.body,event.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET);}
  catch(err){return{statusCode:400,body:'Signature error'};}
  if(evt.type==='checkout.session.completed'){
    const session=evt.data.object;const m=session.metadata||{};
    if(m.eventId){
      const regStore=getStore('event-registrations');
      let regs=[];
      try{const r=await regStore.get(m.eventId,{type:'json'});if(r)regs=r.registrations||[];}catch(e){}
      regs.push({firstName:m.firstName,lastName:m.lastName,email:session.customer_email||'',phone:m.phone,seatType:m.seatType,tableId:m.tableId||null,seatIds:(m.seatIds||'').split(',').filter(Boolean),partySize:parseInt(m.partySize)||1,ticketType:m.ticketType||'base',amount:session.amount_total,registeredAt:new Date().toISOString()});
      await regStore.setJSON(m.eventId,{registrations:regs});
    }
  }
  return{statusCode:200,body:JSON.stringify({received:true})};
};