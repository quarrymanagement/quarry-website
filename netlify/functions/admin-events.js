const Stripe=require('stripe');
const PW=process.env.ADMIN_PASSWORD||'quarry2026';
exports.handler=async(event)=>{
  const headers={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers,body:''};
  const body=JSON.parse(event.body||'{}');
  if(body.password!==PW)return{statusCode:401,headers,body:JSON.stringify({error:'Unauthorized'})};
  const token=process.env.NETLIFY_AUTH_TOKEN;
  const siteId='roaring-pegasus-444826';
  const action=body.action;
  try{
    if(action==='list'){
      const r=await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quarry-events`,{headers:{Authorization:'Bearer '+token}});
      if(!r.ok)return{statusCode:200,headers,body:JSON.stringify({events:[]})};
      const d=await r.json();const keys=d.blobs||[];const events=[];
      for(const k of keys){try{const r2=await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quarry-events/${k.key}`,{headers:{Authorization:'Bearer '+token}});if(r2.ok)events.push(await r2.json());}catch(e){}}
      return{statusCode:200,headers,body:JSON.stringify({events})};
    }
    if(action==='create'){
      const{name,date,time,description,pricePerSeat,tableCount,tableSeats,barSeatCount,category}=body.eventData;
      const eventId='evt-'+Date.now();
      let stripePaymentLink=null;
      if(pricePerSeat>0){
        const stripe=Stripe(process.env.STRIPE_SECRET_KEY);
        const prod=await stripe.products.create({name,description:`${name} — ${date} at ${time}`});
        const price=await stripe.prices.create({product:prod.id,unit_amount:pricePerSeat,currency:'usd'});
        const link=await stripe.paymentLinks.create({line_items:[{price:price.id,quantity:1}],allow_promotion_codes:true});
        stripePaymentLink=link.url;
      }
      const evData={id:eventId,name,date,time,description,pricePerSeat:pricePerSeat||0,tableCount:tableCount||8,tableSeats:tableSeats||4,barSeatCount:barSeatCount||12,totalCapacity:(tableCount||8)*(tableSeats||4)+(barSeatCount||12),category:category||'General',stripePaymentLink,active:true,createdAt:new Date().toISOString()};
      await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quarry-events/event-${eventId}`,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(evData)});
      return{statusCode:200,headers,body:JSON.stringify({success:true,event:evData})};
    }
    if(action==='update'){
      const{eventId,updates}=body;
      const r=await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quarry-events/event-${eventId}`,{headers:{Authorization:'Bearer '+token}});
      if(!r.ok)return{statusCode:404,headers,body:JSON.stringify({error:'Not found'})};
      const existing=await r.json();
      const updated={...existing,...updates,updatedAt:new Date().toISOString()};
      await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quarry-events/event-${eventId}`,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(updated)});
      return{statusCode:200,headers,body:JSON.stringify({success:true,event:updated})};
    }
    if(action==='delete'){
      await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quarry-events/event-${body.eventId}`,{method:'DELETE',headers:{Authorization:'Bearer '+token}});
      return{statusCode:200,headers,body:JSON.stringify({success:true})};
    }
    if(action==='registrations'){
      const r=await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quarry-registrations/event-${body.eventId}`,{headers:{Authorization:'Bearer '+token}});
      if(!r.ok)return{statusCode:200,headers,body:JSON.stringify({registrations:[]})};
      const d=await r.json();return{statusCode:200,headers,body:JSON.stringify({registrations:d.registrations||[]})};
    }
    return{statusCode:400,headers,body:JSON.stringify({error:'Unknown action'})};
  }catch(err){return{statusCode:500,headers,body:JSON.stringify({error:err.message})};}
};