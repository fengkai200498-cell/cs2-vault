const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;
const STEAM_ID = process.env.STEAM_ID || "76561199781756585";
const CACHE_TTL = Number(process.env.CACHE_TTL_MS || 900000);
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
app.use(express.static(path.join(__dirname, "public")));
let cache = { at: 0, data: null }, inflight = null, blockedUntil = 0;

async function fetchInventory() {
  const assets = [], descriptions = new Map(), properties = new Map();
  let start = null, pages = 0;
  while (pages < 30) {
    const url = new URL(`https://steamcommunity.com/inventory/${STEAM_ID}/730/2`);
    url.searchParams.set("l", "english"); url.searchParams.set("count", "2000");
    if (start) url.searchParams.set("start_assetid", start);
    const response = await fetch(url, {headers:{"User-Agent":"Mozilla/5.0 CS2Vault/1.0","Accept":"application/json"},signal:AbortSignal.timeout(20000)});
    if (response.status === 429) { const err = new Error("Steam đang giới hạn truy cập (HTTP 429). Đây là giới hạn từ máy chủ Steam, không phải lỗi quyền riêng tư."); err.status = 429; throw err; }
    if (!response.ok) { const err = new Error(`Steam trả về HTTP ${response.status}.`); err.status = response.status; throw err; }
    const page = await response.json();
    if (Number(page.success) !== 1) throw new Error("Steam không cho phép đọc kho đồ. Hãy đặt Inventory Privacy thành Public.");
    assets.push(...(page.assets || []));
    for (const d of page.descriptions || []) descriptions.set(`${d.classid}_${d.instanceid}`, d);
    for (const p of page.asset_properties || []) properties.set(String(p.assetid), p.asset_properties || []);
    pages++;
    if (!page.more_items || !page.last_assetid) break;
    start = page.last_assetid;
  }
  const items = assets.map(a => {
    const d = descriptions.get(`${a.classid}_${a.instanceid}`) || {}, tags = d.tags || [];
    const props = properties.get(String(a.assetid)) || [];
    const prop = n => props.find(p => String(p.name || "").toLowerCase() === n.toLowerCase());
    const tag = c => tags.find(t => t.category === c)?.localized_tag_name || "";
    const type = d.type || "", weapon = tag("Weapon"), itemType = tag("Type");
    const text = `${type} ${itemType} ${weapon} ${d.name || ""}`.toLowerCase();
    let group = "Khác";
    if (/knife|bayonet|karambit|daggers|kukri|talon|ursus|navaja|stiletto|skeleton|paracord|nomad|survival|bowie|falchion|classic knife|shadow daggers/.test(text)) group = "Dao";
    else if (/gloves|hand wraps|sport gloves|driver gloves|specialist gloves|moto gloves|bloodhound gloves/.test(text)) group = "Găng tay";
    else if (/sticker/.test(text)) group = "Sticker";
    else if (/agent/.test(text)) group = "Đặc vụ";
    else if (/case|container|capsule|package/.test(text)) group = "Hòm & Capsule";
    else if (/rifle|sniper rifle|machinegun|shotgun|smg|pistol/.test(type.toLowerCase()) || weapon) group = "Súng";
    const icon = d.icon_url ? `https://community.akamai.steamstatic.com/economy/image/${d.icon_url}/360fx360f` : "";
    const exterior = (d.market_hash_name || "").match(/\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/i)?.[1] || "";
    const wear = prop("Wear Rating")?.float_value ?? prop("Float Value")?.float_value ?? null;
    const seed = prop("Pattern Template")?.int_value ?? prop("Paint Seed")?.int_value ?? null;
    return {assetid:a.assetid,name:d.market_hash_name || d.name || "Vật phẩm chưa xác định",type:d.type || itemType || "Vật phẩm CS2",group,rarity:tag("Rarity") || "Chưa rõ",exterior,icon,tradable:!!d.tradable,marketable:!!d.marketable,amount:Number(a.amount || 1),floatValue:wear===null?null:Number(wear),paintSeed:seed===null?null:Number(seed),statTrak:/stattrak/i.test(d.name || ""),souvenir:/souvenir/i.test(d.name || "")};
  });
  return {steamId:STEAM_ID,total:assets.length,itemCount:items.reduce((n,x)=>n+x.amount,0),pages,fetchedAt:new Date().toISOString(),items};
}
app.get("/api/inventory", async (req,res) => {
  if (req.query.refresh !== "1" && cache.data && Date.now()-cache.at<CACHE_TTL) return res.json({...cache.data,cached:true});
  try {
    if (!inflight) inflight = fetchInventory().then(data => {cache={at:Date.now(),data};return data;}).finally(()=>{inflight=null;});
    res.json({...await inflight,cached:false});
  } catch (e) {
    if (e.status === 429) blockedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    if (cache.data) return res.json({...cache.data,cached:true,stale:true,warning:e.message});
    res.status(e.status === 429 ? 429 : 502).json({error:e.message || "Không thể tải kho đồ Steam.",hint:e.status === 429 ? "Steam đang giới hạn IP máy chủ. Không nên liên tục bấm làm mới; hãy chờ hệ thống tự thử lại." : "Nếu kho đồ đã Public mà vẫn lỗi, hãy kiểm tra trạng thái Steam."});
  }
});
app.get("/health",(_req,res)=>res.json({ok:true}));
app.listen(PORT,()=>console.log(`CS2 Vault listening on ${PORT}`));
