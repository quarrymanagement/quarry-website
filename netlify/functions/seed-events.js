const fetch=require('node-fetch');
exports.handler=async(event)=>{
  const h={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers:h,body:''};
  // Only allow GET to seed initial event data
  const token=process.env.NETLIFY_AUTH_TOKEN;
  const siteId='roaring-pegasus-444826';
  const EVENTS=[
    {
      id:'neon-bingo-apr-2026',
      title:'Ladies Neon Singo Bingo Brunch',
      subtitle:'Neon 80s Singo-Bingo',
      date:'April 12, 2026',
      dateISO:'2026-04-12',
      startTime:'8:40 AM',
      endTime:'11:40 AM',
      location:'The Quarry, 3960 State Hwy Z, Wentzville, MO 63385',
      description:'Get your neon on! Join us for a glowing 80s-themed Singo Bingo Brunch at The Quarry. Sing along to your favorite 80s hits while playing Bingo — great food, great music, great vibes.',
      priceBase:35,
      pricePremium:45,
      priceBaseLabel:'Bingo + Brunch',
      pricePremiumLabel:'Bottomless Mimosas/Bloody Marys + Brunch + Bingo',
      tableCount:10,
      tableSize:6,
      barSeatCount:12,
      totalCapacity:72,
      status:'active',
      image:'',
      tags:['Ladies Event','Brunch','Bingo','80s Theme']
    }
  ];
  const results=[];
  for(const ev of EVENTS){
    const url='https://api.netlify.com/api/v1/blobs/'+siteId+'/quarry-events/'+ev.id;
    const r=await fetch(url,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(ev)});
    results.push(ev.id+':'+(r.ok?'seeded':'error '+r.status));
  }
  return{statusCode:200,headers:h,body:JSON.stringify({seeded:results})};
};