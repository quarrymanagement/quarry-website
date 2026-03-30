const fetch = require("node-fetch");
exports.handler = async () => {
  const headers = {"Access-Control-Allow-Origin":"*","Content-Type":"application/json"};
  try {
    const res = await fetch("https://www.wixapis.com/events/v3/events/query", {
      method: "POST",
      headers: {"Content-Type":"application/json","Authorization": process.env.WIX_API_KEY||"","wix-site-id":"02203c40-3b9d-40bb-9cd3-e8dbfc720ecf"},
      body: JSON.stringify({query:{paging:{limit:50},sort:[{fieldName:"start",order:"ASC"}]}})
    });
    const data = await res.json();
    return {statusCode:200,headers,body:JSON.stringify({events:data.events||[]})};
  } catch(e) {
    return {statusCode:200,headers,body:JSON.stringify({events:[],error:e.message})};
  }
};
