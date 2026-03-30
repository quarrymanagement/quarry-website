const Stripe=require('stripe');const fetch=require('node-fetch');
exports.handler=async(event)=>{
  const h={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  const stripe=Stripe(process.env.STRIPE_SECRET_KEY);
  const sig=event.headers['stripe-signature'];
  let evt;
  try{evt=stripe.webhooks.constructEvent(event.body,sig,process.env.STRIPE_WEBHOOK_SECRET);}
  catch(err){console.error('Webhook sig error:',err.message);return{statusCode:400,body:'Signature error'};}
  if(evt.type==='checkout.session.completed'){
    const session=evt.data.object;
    const m=session.metadata||{};
    const{eventId,firstName,lastName,phone,seatType,tableId,partySize,ticketType}=m;
    const seatIds=(m.seatIds||'').split(',').filter(Boolean);
    const token=process.env.NETLIFY_AUTH_TOKEN;
    const siteId='roaring-pegasus-444826';
    if(eventId){
      const url='https://api.netlify.com/api/v1/blobs/'+siteId+'/event-registrations/'+eventId;
      let regs=[];
      try{const r=await fetch(url,{headers:{Authorization:'Bearer '+token}});if(r.ok){const d=await r.json();regs=d.registrations||[];}}catch(e){}
      regs.push({firstName,lastName,email:session.customer_email||session.customer_details?.email||'',phone,seatType,tableId:tableId||null,seatIds,partySize:parseInt(partySize)||1,ticketType:ticketType||'base',amount:session.amount_total,registeredAt:new Date().toISOString()});
      await fetch(url,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({registrations:regs})});
      // Notify owner
      await fetch('https://roaring-pegasus-444826.netlify.app/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({'form-name':'event-registration-notification','eventId':eventId,'name':firstName+' '+lastName,'email':session.customer_email||'','seatType':seatType,'table':tableId||'','seats':seatIds.join(','),'party':partySize,'ticket':ticketType,'amount':'$'+(session.amount_total/100).toFixed(2)}).toString()});
    }
  }
  return{statusCode:200,body:JSON.stringify({received:true})};
};