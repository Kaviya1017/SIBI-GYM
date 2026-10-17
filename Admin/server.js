const express=require("express"),session=require("express-session"),Database=require("better-sqlite3"),bcrypt=require("bcryptjs"),helmet=require("helmet"),rateLimit=require("express-rate-limit"),path=require("path"),fs=require("fs"),crypto=require("crypto");
// Load local .env values without overriding environment variables supplied by the host.
const envFile=path.resolve(__dirname,'.env');
if(fs.existsSync(envFile)){for(const line of fs.readFileSync(envFile,'utf8').split(/\r?\n/)){const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);if(m&&!m[2].startsWith('#')&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^(["'])(.*)\1$/,'$2')}}
const app=express(),PORT=Number(process.env.PORT||3000),ROOT=__dirname,dataDir=path.resolve(ROOT,"data");
fs.mkdirSync(dataDir,{recursive:true});
const dbFile=path.resolve(ROOT,process.env.DATABASE_FILE||"./data/elevate.sqlite");fs.mkdirSync(path.dirname(dbFile),{recursive:true});
const db=new Database(dbFile);db.pragma("journal_mode=WAL");db.pragma("foreign_keys=ON");
db.exec(`CREATE TABLE IF NOT EXISTS session_store(sid TEXT PRIMARY KEY,sess TEXT NOT NULL,expires_at INTEGER NOT NULL);`);
class SQLiteSessionStore extends session.Store{
  get(sid,cb){try{const r=db.prepare("SELECT sess,expires_at FROM session_store WHERE sid=?").get(sid);if(!r||r.expires_at<=Date.now()){if(r)db.prepare("DELETE FROM session_store WHERE sid=?").run(sid);return cb(null,null)}cb(null,JSON.parse(r.sess))}catch(e){cb(e)}}
  set(sid,sess,cb){try{const expires= sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now()+86400000;db.prepare("INSERT INTO session_store(sid,sess,expires_at) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess,expires_at=excluded.expires_at").run(sid,JSON.stringify(sess),expires);cb&&cb(null)}catch(e){cb&&cb(e)}}
  destroy(sid,cb){try{db.prepare("DELETE FROM session_store WHERE sid=?").run(sid);cb&&cb(null)}catch(e){cb&&cb(e)}}
  touch(sid,sess,cb){this.set(sid,sess,cb)}
}
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,member_id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,email TEXT NOT NULL COLLATE NOCASE UNIQUE,phone TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin')),plan TEXT NOT NULL DEFAULT 'Basic',status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','paused')),created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS trainers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,specialty TEXT NOT NULL,experience_years INTEGER NOT NULL DEFAULT 1,bio TEXT NOT NULL,certifications TEXT NOT NULL DEFAULT '',photo_url TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS enquiries(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,phone TEXT NOT NULL,email TEXT NOT NULL,topic TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new',created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS reminders(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,audience TEXT NOT NULL,message TEXT NOT NULL,scheduled_at_utc TEXT NOT NULL,display_timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',status TEXT NOT NULL DEFAULT 'draft',created_by INTEGER,created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),FOREIGN KEY(created_by) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY AUTOINCREMENT,transaction_ref TEXT NOT NULL UNIQUE,user_id INTEGER NOT NULL,amount_paise INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','failed')),method TEXT NOT NULL DEFAULT 'manual',notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS announcements(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,message TEXT NOT NULL,audience TEXT NOT NULL DEFAULT 'all',created_by INTEGER,created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),FOREIGN KEY(created_by) REFERENCES users(id));
CREATE INDEX IF NOT EXISTS idx_users_member_id ON users(member_id);CREATE INDEX IF NOT EXISTS idx_enquiries_created ON enquiries(created_at);CREATE INDEX IF NOT EXISTS idx_enquiries_status ON enquiries(status);CREATE INDEX IF NOT EXISTS idx_reminders_scheduled ON reminders(scheduled_at_utc);CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id,created_at);`);
const enquiryColumns=db.prepare("PRAGMA table_info(enquiries)").all().map(c=>c.name);
if(!enquiryColumns.includes("place")) db.exec("ALTER TABLE enquiries ADD COLUMN place TEXT NOT NULL DEFAULT ''");
if(!enquiryColumns.includes("converted_user_id")) db.exec("ALTER TABLE enquiries ADD COLUMN converted_user_id INTEGER");
db.exec("UPDATE enquiries SET place=trim(substr(topic,instr(topic,' · ')+3)) WHERE place='' AND instr(topic,' · ')>0");
db.exec("UPDATE enquiries SET topic=trim(substr(topic,1,instr(topic,' · ')-1)) WHERE instr(topic,' · ')>0");
const userColumns=db.prepare("PRAGMA table_info(users)").all().map(c=>c.name);
if(!userColumns.includes("membership_due_date")) db.exec("ALTER TABLE users ADD COLUMN membership_due_date TEXT");
if(!userColumns.includes("address")) db.exec("ALTER TABLE users ADD COLUMN address TEXT NOT NULL DEFAULT ''");
if(!userColumns.includes("height_cm")) db.exec("ALTER TABLE users ADD COLUMN height_cm REAL");
if(!userColumns.includes("weight_kg")) db.exec("ALTER TABLE users ADD COLUMN weight_kg REAL");
if(!userColumns.includes("profile_photo")) db.exec("ALTER TABLE users ADD COLUMN profile_photo TEXT NOT NULL DEFAULT ''");
for (const [column,type] of [["age","INTEGER"],["gender","TEXT NOT NULL DEFAULT ''"],["fitness_goal","TEXT NOT NULL DEFAULT ''"],["preferred_membership","TEXT NOT NULL DEFAULT ''"],["emergency_contact","TEXT NOT NULL DEFAULT ''"]]) { if(!userColumns.includes(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} ${type}`); }
db.exec(`CREATE TABLE IF NOT EXISTS message_templates(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  template_id INTEGER,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  image_data TEXT NOT NULL DEFAULT '',
  delivery_mode TEXT NOT NULL DEFAULT 'manual' CHECK(delivery_mode IN ('manual','automatic')),
  scheduled_at TEXT,
  sent_at TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK(status IN ('scheduled','sent','cancelled')),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(template_id) REFERENCES message_templates(id),
  FOREIGN KEY(created_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id,created_at);
CREATE INDEX IF NOT EXISTS idx_messages_schedule ON messages(status,scheduled_at);`);
// Upgrade legacy message records so failures are visible instead of being falsely marked sent.
const messageSchema=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get()?.sql||"";
if(!messageSchema.includes("'failed'")){
  db.exec(`DROP INDEX IF EXISTS idx_messages_user; DROP INDEX IF EXISTS idx_messages_schedule;
    ALTER TABLE messages RENAME TO messages_legacy_migration;
    CREATE TABLE messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,template_id INTEGER,subject TEXT NOT NULL DEFAULT '',body TEXT NOT NULL,image_data TEXT NOT NULL DEFAULT '',
      delivery_mode TEXT NOT NULL DEFAULT 'manual' CHECK(delivery_mode IN ('manual','automatic')),scheduled_at TEXT,sent_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','scheduled','sent','failed','cancelled')),
      delivery_error TEXT NOT NULL DEFAULT '',provider_message_id TEXT NOT NULL DEFAULT '',created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(template_id) REFERENCES message_templates(id),FOREIGN KEY(created_by) REFERENCES users(id));
    INSERT INTO messages(id,user_id,template_id,subject,body,image_data,delivery_mode,scheduled_at,sent_at,status,created_by,created_at)
      SELECT id,user_id,template_id,subject,body,image_data,delivery_mode,scheduled_at,sent_at,status,created_by,created_at FROM messages_legacy_migration;
    DROP TABLE messages_legacy_migration;
    CREATE INDEX idx_messages_user ON messages(user_id,created_at); CREATE INDEX idx_messages_schedule ON messages(status,scheduled_at);`);
}else{
  const cols=db.prepare("PRAGMA table_info(messages)").all().map(c=>c.name);
  if(!cols.includes('delivery_error'))db.exec("ALTER TABLE messages ADD COLUMN delivery_error TEXT NOT NULL DEFAULT ''");
  if(!cols.includes('provider_message_id'))db.exec("ALTER TABLE messages ADD COLUMN provider_message_id TEXT NOT NULL DEFAULT ''");
}
// Provider status is separate from the local queue status: Meta can accept a message
// first and later report sent, delivered, read, or failed through the webhook.
{
  const cols=db.prepare("PRAGMA table_info(messages)").all().map(c=>c.name);
  if(!cols.includes('delivery_status')) db.exec("ALTER TABLE messages ADD COLUMN delivery_status TEXT NOT NULL DEFAULT ''");
}
const seedTemplates=[
  ["Festival message","festival","Festival Greetings","Wishing you and your family a joyful festival from the Sibi Sports Club team! We hope you have a wonderful celebration."],
  ["Maintenance update","maintenance","Maintenance Update","Hi {{name}}, the club will have a maintenance update on {{date}}. Thank you for your understanding."],
  ["Welcome message","welcome","Welcome to Sibi","Hi {{name}}, welcome to Sibi Sports Club! Your member ID is {{member_id}}. We are excited to have you with us."],
  ["Membership renewal","renewal","Membership Renewal","Hi {{name}}, your Sibi membership is coming up for renewal. Please contact the club team to continue your plan."],
  ["Offers & packages","offers","Special Offer","Hi {{name}}, we have a new membership offer and package update for you. Contact the Sibi team to learn more."],
  ["Custom message","custom","Message from Sibi","Hi {{name}}, greetings from Sibi Sports Club!"]
];
const templateInsert=db.prepare("INSERT OR IGNORE INTO message_templates(name,category,subject,body) VALUES(?,?,?,?)");
seedTemplates.forEach(t=>templateInsert.run(...t));
const clubTrainers=[
  ["Mahalingam","Personal Training & Strength",8,"Experienced in handling personal training sessions and member conditioning.","Personal Training · Strength Training"],
  ["Ameen","Personal Training & Athletic Performance",8,"Experienced coach focused on structured PT sessions and performance development.","Personal Training · Athletic Performance"],
  ["Rajesh","Strength & Weight Training",8,"Supports members with practical strength, weight training and progressive programs.","Strength Training · Weight Training"],
  ["Ramesh","Cardio & Endurance Training",8,"Helps members build stamina, conditioning and athletic endurance safely.","Cardio · Endurance"]
];
const trainerNames=new Set(db.prepare("SELECT name FROM trainers WHERE active=1").all().map(x=>x.name));
if(trainerNames.has("Arjun Menon")||trainerNames.has("Priya Raman")||trainerNames.has("Karthik Iyer")){db.prepare("UPDATE trainers SET active=0 WHERE name IN ('Arjun Menon','Priya Raman','Karthik Iyer')").run()}
const addTrainer=db.prepare("INSERT INTO trainers(name,specialty,experience_years,bio,certifications) VALUES(?,?,?,?,?)");
clubTrainers.forEach(t=>{if(!db.prepare("SELECT id FROM trainers WHERE name=? AND active=1").get(t[0]))addTrainer.run(...t)});
async function seedAdmin(){const email=String(process.env.ADMIN_EMAIL||"admin@elevate.local").trim().toLowerCase(),password=String(process.env.ADMIN_PASSWORD||"admin@2026");const hash=await bcrypt.hash(password,12);const old=db.prepare("SELECT id FROM users WHERE email=? OR member_id='SSC-ADMIN'").get(email);if(!old){db.prepare("INSERT INTO users(member_id,name,email,phone,password_hash,role,plan,status) VALUES(?,?,?,?,?,'admin','Staff','active')").run("SSC-ADMIN",process.env.ADMIN_NAME||"Sibi Administrator",email,"Not provided",hash)}else db.prepare("UPDATE users SET email=?,name=?,password_hash=?,role='admin',status='active' WHERE id=?").run(email,process.env.ADMIN_NAME||"Sibi Administrator",hash,old.id)}
const SCHEDULE_POLL_INTERVAL_MS=5000;
app.disable("x-powered-by");app.get("/health",(req,res)=>res.json({ok:true,service:"sibi-sports-club",scheduler:"running",scheduler_interval_ms:SCHEDULE_POLL_INTERVAL_MS,time:new Date().toISOString()}));app.use(helmet({contentSecurityPolicy:false}));app.use(express.json({limit:"3mb"}));app.use(express.urlencoded({extended:false,limit:"100kb"}));
app.use(session({store:new SQLiteSessionStore(),secret:process.env.SESSION_SECRET||"development-only-change-me",resave:false,saveUninitialized:false,name:"sibi.sid",rolling:true,cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:28800000}}));
app.use("/api/auth",rateLimit({windowMs:900000,limit:30,standardHeaders:true,legacyHeaders:false}));
app.use("/api",(req,res,next)=>{res.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");res.set("Pragma","no-cache");res.set("Expires","0");next()});
const clean=(v,n=500)=>typeof v==="string"?v.trim().slice(0,n):"";
function parseScheduledDate(value){
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value||''));
  if(!match)return new Date(Number.NaN);
  const [,year,month,day,hour,minute]=match.map(Number);
  const localAsUtc=new Date(Date.UTC(year,month-1,day,hour,minute));
  if(localAsUtc.getUTCFullYear()!==year||localAsUtc.getUTCMonth()!==month-1||localAsUtc.getUTCDate()!==day||localAsUtc.getUTCHours()!==hour||localAsUtc.getUTCMinutes()!==minute)return new Date(Number.NaN);
  return new Date(localAsUtc.getTime()-330*60*1000);
}
// Meta webhook verification and delivery receipts. Set WHATSAPP_WEBHOOK_VERIFY_TOKEN in hosting settings.
app.get('/api/whatsapp/webhook',(req,res)=>{
  const mode=req.query['hub.mode'],token=req.query['hub.verify_token'],challenge=req.query['hub.challenge'];
  if(mode==='subscribe' && process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN && token===process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) return res.status(200).send(String(challenge||''));
  return res.sendStatus(403);
});
app.post('/api/whatsapp/webhook',(req,res)=>{
  // If APP_SECRET is configured, verify the webhook signature before trusting status updates.
  const appSecret=process.env.WHATSAPP_APP_SECRET,signature=req.get('x-hub-signature-256');
  if(appSecret){
    const expected='sha256='+crypto.createHmac('sha256',appSecret).update(JSON.stringify(req.body)).digest('hex');
    const a=Buffer.from(String(signature||'')),b=Buffer.from(expected);
    if(a.length!==b.length||!crypto.timingSafeEqual(a,b)) return res.sendStatus(401);
  }
  try{
    for(const entry of (req.body?.entry||[])) for(const change of (entry.changes||[])) for(const item of (change.value?.statuses||[])){
      const id=String(item.id||''); const state=String(item.status||'').toLowerCase();
      if(!id||!['sent','delivered','read','failed'].includes(state)) continue;
      const error=state==='failed'?(item.errors||[]).map(e=>e.error_data?.details||e.message||e.title||'WhatsApp reported delivery failure').join('; ').slice(0,500):'';
      db.prepare("UPDATE messages SET delivery_status=?,delivery_error=CASE WHEN ?<>'' THEN ? ELSE delivery_error END WHERE provider_message_id=?").run(state,error,error,id);
    }
    return res.sendStatus(200);
  }catch(e){console.error('WhatsApp webhook processing failed:',e);return res.sendStatus(500)}
});
function normalizeEmail(email,memberId){return email||`${memberId}@member.local`}
function displayUser(u){if(!u)return u;return {...u,email:(u.email||"").endsWith("@member.local")?"":u.email}}
function me(req){return req.session.userId?displayUser(db.prepare("SELECT id,member_id,name,email,phone,address,role,plan,status,membership_due_date,height_cm,weight_kg,profile_photo,age,gender,fitness_goal,preferred_membership,emergency_contact,created_at FROM users WHERE id=?").get(req.session.userId)||null):null}
function auth(req,res,next){const u=me(req);if(!u)return res.status(401).json({error:"Please sign in to continue."});req.user=u;next()}
function admin(req,res,next){const u=me(req);if(!u||u.role!=="admin")return res.status(403).json({error:"Administrator access required."});req.user=u;next()}
function makeMemberId(){const year=new Date().getUTCFullYear(),prefix=`SSC-${year}-`,last=db.prepare("SELECT member_id FROM users WHERE member_id LIKE ? ORDER BY id DESC LIMIT 1").get(`${prefix}%`);return `${prefix}${String(last?Number(last.member_id.slice(prefix.length))+1:1).padStart(6,"0")}`}
const createMember=db.transaction(data=>{
  const id=makeMemberId(),email=normalizeEmail(data.email,id);
  const r=db.prepare("INSERT INTO users(member_id,name,email,phone,address,password_hash,role,plan,status,age,gender,fitness_goal,preferred_membership,emergency_contact,height_cm,weight_kg,profile_photo) VALUES(?,?,?,?,?,? ,'member',?,?,?,?,?,?,?,?,?,?)")
    .run(id,data.name,email,data.phone,data.address||"",data.hash,data.plan||"Basic",data.status||"pending",data.age||null,data.gender||"",data.fitness_goal||"",data.preferred_membership||"",data.emergency_contact||"",data.height_cm||null,data.weight_kg||null,data.profile_photo||"");
  return displayUser(db.prepare("SELECT id,member_id,name,email,phone,address,role,plan,status,membership_due_date,height_cm,weight_kg,profile_photo,age,gender,fitness_goal,preferred_membership,emergency_contact,created_at FROM users WHERE id=?").get(r.lastInsertRowid));
});
app.get("/api/health",(req,res)=>res.json({ok:true,timezone:process.env.APP_TIMEZONE||"Asia/Kolkata"}));
app.post("/api/auth/register",async(req,res)=>{const name=clean(req.body.name,100),email=clean(req.body.email,160).toLowerCase(),phone=clean(req.body.phone,30),address=clean(req.body.address,300),age=Number(req.body.age),gender=clean(req.body.gender,30),fitness_goal=Array.isArray(req.body.fitness_goal)?req.body.fitness_goal.map(v=>clean(v,60)).filter(Boolean).join(", "):clean(req.body.fitness_goal,300),preferred_membership=clean(req.body.preferred_membership,100),emergency_contact=clean(req.body.emergency_contact,30);if(name.length<2||phone.length<7||!Number.isInteger(age)||age<12||age>100||!gender||!address||!fitness_goal||!preferred_membership||emergency_contact.length<7||email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({error:"Please complete your name, age, gender, phone, address, fitness goal, preferred membership and emergency contact. Email is optional."});try{const plan=preferred_membership.includes("3 Months")?"Basic":"Basic";const tempPassword=`Sibi@${Math.random().toString(36).slice(2,8).toUpperCase()}!`;const user=createMember({name,email,phone,address,age,gender,fitness_goal,preferred_membership,emergency_contact,plan,status:"pending",hash:await bcrypt.hash(tempPassword,12)});req.session.userId=user.id;res.status(201).json({user,temporaryPassword:tempPassword,message:"Registration submitted successfully."})}catch(e){if(String(e.code||"").startsWith("SQLITE_CONSTRAINT"))return res.status(409).json({error:"An account with that email or phone already exists."});console.error(e);res.status(500).json({error:"Could not complete registration."})}});
app.post("/api/auth/login",async(req,res)=>{const identifier=clean(req.body.email||req.body.identifier,160).toLowerCase(),password=typeof req.body.password==="string"?req.body.password:"",u=db.prepare("SELECT * FROM users WHERE lower(email)=? OR lower(member_id)=?").get(identifier,identifier);if(!u||!(await bcrypt.compare(password,u.password_hash)))return res.status(401).json({error:"Member ID/email or password is incorrect."});req.session.userId=u.id;const user=me(req);res.json({user,redirect:user.role==="admin"?"/admin.html":"/member.html"})});
app.post("/api/auth/logout",(req,res)=>req.session.destroy(e=>{if(e)return res.status(500).json({error:"Could not sign out."});res.clearCookie("sibi.sid",{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production"});res.json({ok:true})}));
app.get("/api/auth/me",auth,(req,res)=>res.json({user:req.user}));
app.get("/api/trainers",(req,res)=>res.json({trainers:db.prepare("SELECT id,name,specialty,experience_years,bio,certifications,photo_url FROM trainers WHERE active=1 ORDER BY id").all()}));
app.post("/api/enquiries",(req,res)=>{const name=clean(req.body.name,100),phone=clean(req.body.phone,30),email=clean(req.body.email,160).toLowerCase(),place=clean(req.body.place,160),topic=clean(req.body.topic,100)||"General enquiry",message=clean(req.body.message,2000);if(name.length<2||phone.length<7||email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||place.length<2||message.length<5)return res.status(400).json({error:"Please complete your name, phone, place and message. Email is optional."});const r=db.prepare("INSERT INTO enquiries(name,phone,email,place,topic,message) VALUES(?,?,?,?,?,?)").run(name,phone,email,place,topic,message);res.status(201).json({ok:true,enquiryId:r.lastInsertRowid})});
app.get("/api/member/dashboard",auth,(req,res)=>{if(req.user.role!=="member")return res.status(403).json({error:"Please use the admin dashboard."});const latestPayment=db.prepare("SELECT status FROM payments WHERE user_id=? ORDER BY id DESC LIMIT 1").get(req.user.id);res.json({user:req.user,paymentStatus:latestPayment?.status||"pending",planOptions:[{name:"Monthly",price:899},{name:"3 Months",price:2000},{name:"6 Months",price:null},{name:"1 Year",price:6999},{name:"Personal Training",price:5000},{name:"Cardio",price:1400}]})});
app.patch("/api/member/profile",auth,(req,res)=>{
if(req.user.role!=="member")return res.status(403).json({error:"Member account required."});
const name=clean(req.body.name,100),email=clean(req.body.email,160).toLowerCase(),phone=clean(req.body.phone,30),address=clean(req.body.address,250);
if(name.length<2||email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||phone.length<7)return res.status(400).json({error:"Enter a valid name, optional email and WhatsApp/phone number."});
try{db.prepare("UPDATE users SET name=?,email=?,phone=?,address=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(name,normalizeEmail(email,req.user.member_id),phone,address,req.user.id);res.json({user:me(req)});}catch(e){if(String(e.code||"").includes("CONSTRAINT"))return res.status(409).json({error:"That email address is already in use."});throw e;}
});
app.get("/api/member/payments",auth,(req,res)=>{if(req.user.role!=="member")return res.status(403).json({error:"Member account required."});res.json({payments:db.prepare("SELECT transaction_ref,amount_paise,status,method,notes,created_at FROM payments WHERE user_id=? ORDER BY id DESC LIMIT 100").all(req.user.id)});});
app.patch("/api/member/plan",auth,(req,res)=>{if(req.user.role!=="member")return res.status(403).json({error:"Member account required."});const plan=clean(req.body.plan,60);if(!["Basic","Premium","Elite"].includes(plan))return res.status(400).json({error:"Select a valid package."});db.prepare("UPDATE users SET plan=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(plan,req.user.id);res.json({user:me(req),message:"Package selection saved."})});
app.get("/api/admin/dashboard",admin,(req,res)=>res.json({admin:req.user,stats:{members:db.prepare("SELECT COUNT(*) n FROM users WHERE role='member'").get().n,activeMembers:db.prepare("SELECT COUNT(*) n FROM users WHERE role='member' AND status='active'").get().n,pendingMembers:db.prepare("SELECT COUNT(*) n FROM users WHERE role='member' AND status='pending'").get().n,pausedMembers:db.prepare("SELECT COUNT(*) n FROM users WHERE role='member' AND status='paused'").get().n,trainers:db.prepare("SELECT COUNT(*) n FROM trainers WHERE active=1").get().n,enquiries:db.prepare("SELECT COUNT(*) n FROM enquiries WHERE status='new'").get().n,pendingPayments:db.prepare("SELECT COUNT(*) n FROM payments WHERE status='pending'").get().n,dueSoon:db.prepare("SELECT COUNT(*) n FROM users WHERE role='member' AND membership_due_date IS NOT NULL AND date(membership_due_date)<=date('now','+7 day')").get().n}}));
app.post("/api/admin/members",admin,async(req,res)=>{
const name=clean(req.body.name,100),email=clean(req.body.email,160).toLowerCase(),phone=clean(req.body.phone,30),plan=clean(req.body.plan,60)||"Basic",status=clean(req.body.status,20)||"active",height=Number(req.body.height_cm)||null,weight=Number(req.body.weight_kg)||null,photo=clean(req.body.profile_photo,2500000),due=clean(req.body.membership_due_date,30);
if(name.length<2||phone.length<7||email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!["Basic","Premium","Elite"].includes(plan)||!["pending","active","paused"].includes(status))return res.status(400).json({error:"Enter name, phone and valid membership details. Email is optional."});
if(db.prepare("SELECT id FROM users WHERE role='member' AND phone=?").get(phone))return res.status(409).json({error:"That phone number is already registered."});
if(due&&!/^\d{4}-\d{2}-\d{2}$/.test(due))return res.status(400).json({error:"Membership due date must use YYYY-MM-DD."});
const tempPassword=`Sibi@${Math.random().toString(36).slice(2,8).toUpperCase()}!`;
try{const user=createMember({name,email,phone,hash:await bcrypt.hash(tempPassword,12),plan,status,height_cm:height,weight_kg:weight,profile_photo:photo});db.prepare("UPDATE users SET membership_due_date=? WHERE id=?").run(due||null,user.id);res.status(201).json({user:displayUser(db.prepare("SELECT id,member_id,name,email,phone,address,plan,status,membership_due_date,height_cm,weight_kg,profile_photo,age,gender,fitness_goal,preferred_membership,emergency_contact,created_at FROM users WHERE id=?").get(user.id)),temporaryPassword:tempPassword,message:"Member created successfully."});}catch(e){if(String(e.code||"").includes("CONSTRAINT"))return res.status(409).json({error:"That email address is already used by another account."});console.error(e);res.status(500).json({error:"Could not create member."})}
});
const memberSelect=`SELECT u.id,u.member_id,u.name,u.email,u.phone,u.address,u.plan,u.status,u.membership_due_date,u.height_cm,u.weight_kg,u.profile_photo,u.age,u.gender,u.fitness_goal,u.preferred_membership,u.emergency_contact,u.created_at,u.updated_at,(SELECT p.status FROM payments p WHERE p.user_id=u.id ORDER BY p.id DESC LIMIT 1) AS payment_status,(SELECT p.method FROM payments p WHERE p.user_id=u.id ORDER BY p.id DESC LIMIT 1) AS payment_method,(SELECT p.created_at FROM payments p WHERE p.user_id=u.id ORDER BY p.id DESC LIMIT 1) AS last_payment_at FROM users u WHERE u.role='member'`;
app.get("/api/admin/members",admin,(req,res)=>{res.json({members:db.prepare(`${memberSelect} ORDER BY u.id DESC LIMIT 1000`).all(),fetched_at:new Date().toISOString()})});
app.get("/api/admin/members/:id",admin,(req,res)=>{const id=Number(req.params.id),member=db.prepare(`${memberSelect} AND u.id=?`).get(id);if(!member)return res.status(404).json({error:"Member not found."});res.json({member,fetched_at:new Date().toISOString()})});
app.patch("/api/admin/members/:id",admin,(req,res)=>{
const id=Number(req.params.id),name=clean(req.body.name,100),email=clean(req.body.email,160).toLowerCase(),phone=clean(req.body.phone,30),address=clean(req.body.address,250),plan=clean(req.body.plan,60),status=clean(req.body.status,20),due=clean(req.body.membership_due_date,30),height=Number(req.body.height_cm)||null,weight=Number(req.body.weight_kg)||null,photo=clean(req.body.profile_photo,2500000),paymentStatus=clean(req.body.payment_status,20);
if(!Number.isInteger(id)||id<1||name.length<2||email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||phone.length<7||!["Basic","Premium","Elite"].includes(plan)||!["pending","active","paused"].includes(status)||paymentStatus&&!["pending","completed","failed"].includes(paymentStatus))return res.status(400).json({error:"Check the customer name, email, phone, plan, membership status and payment status."});
if(due&&!/^\d{4}-\d{2}-\d{2}$/.test(due))return res.status(400).json({error:"Membership due date must use YYYY-MM-DD."});
try{const member=db.prepare("SELECT member_id FROM users WHERE id=? AND role='member'").get(id);if(!member)return res.status(404).json({error:"Member not found."});const duplicate=db.prepare("SELECT id FROM users WHERE role='member' AND phone=? AND id<>?").get(phone,id);if(duplicate)return res.status(409).json({error:"That phone number is already registered to another member."});db.prepare("UPDATE users SET name=?,email=?,phone=?,address=?,plan=?,status=?,membership_due_date=?,height_cm=?,weight_kg=?,profile_photo=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND role='member'").run(name,normalizeEmail(email,member.member_id),phone,address,plan,status,due||null,height,weight,photo,id);if(paymentStatus){const latest=db.prepare("SELECT id FROM payments WHERE user_id=? ORDER BY id DESC LIMIT 1").get(id);if(latest)db.prepare("UPDATE payments SET status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(paymentStatus,latest.id)}res.json({ok:true,member:db.prepare(`${memberSelect} AND u.id=?`).get(id)});}catch(e){if(String(e.code||"").includes("CONSTRAINT"))return res.status(409).json({error:"That email address is already used by another account."});throw e;}
});
app.patch("/api/admin/members/:id/status",admin,(req,res)=>{const status=clean(req.body.status,20);if(!["pending","active","paused"].includes(status))return res.status(400).json({error:"Invalid member status."});const r=db.prepare("UPDATE users SET status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND role='member'").run(status,Number(req.params.id));if(!r.changes)return res.status(404).json({error:"Member not found."});res.json({ok:true})});
app.get("/api/admin/payments",admin,(req,res)=>res.json({payments:db.prepare(`SELECT p.id,p.transaction_ref,p.user_id,u.member_id,u.name,u.email,u.phone,p.amount_paise,p.status,p.method,p.notes,p.created_at,p.updated_at FROM payments p JOIN users u ON u.id=p.user_id WHERE u.role='member' ORDER BY p.id DESC LIMIT 1000`).all()}));
app.post("/api/admin/payments",admin,(req,res)=>{
const userId=Number(req.body.user_id),amount=Number(req.body.amount),status=clean(req.body.status,20),method=clean(req.body.method,40)||"cash",notes=clean(req.body.notes,500);
if(!Number.isInteger(userId)||userId<1||!Number.isFinite(amount)||amount<=0||amount>10000000||!["pending","completed","failed"].includes(status)||!["cash","card","gpay","bank_transfer"].includes(method))return res.status(400).json({error:"Choose a customer, valid amount, status and payment method."});
if(!db.prepare("SELECT id FROM users WHERE id=? AND role='member'").get(userId))return res.status(404).json({error:"Member not found."});
const ref=`SSC-MAN-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
const r=db.prepare("INSERT INTO payments(transaction_ref,user_id,amount_paise,status,method,notes) VALUES(?,?,?,?,?,?)").run(ref,userId,Math.round(amount*100),status,method,notes);
res.status(201).json({payment:db.prepare("SELECT * FROM payments WHERE id=?").get(r.lastInsertRowid),message:"Payment record saved."});
});
app.patch("/api/admin/payments/:id",admin,(req,res)=>{
const status=clean(req.body.status,20);if(!["pending","completed","failed"].includes(status))return res.status(400).json({error:"Invalid payment status."});
const r=db.prepare("UPDATE payments SET status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(status,Number(req.params.id));
if(!r.changes)return res.status(404).json({error:"Payment record not found."});res.json({ok:true});
});
app.get("/api/admin/templates",admin,(req,res)=>res.json({templates:db.prepare("SELECT id,name,category,subject,body,created_at,updated_at FROM message_templates ORDER BY id").all()}));
app.post("/api/admin/templates",admin,(req,res)=>{const name=clean(req.body.name,100),category=clean(req.body.category,40),subject=clean(req.body.subject,160),body=clean(req.body.body,3000);if(!name||!category||!body)return res.status(400).json({error:"Template name, category and message are required."});const existing=db.prepare("SELECT id FROM message_templates WHERE lower(name)=lower(?)").get(name);if(existing){db.prepare("UPDATE message_templates SET category=?,subject=?,body=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(category,subject,body,existing.id);return res.json({template:db.prepare("SELECT * FROM message_templates WHERE id=?").get(existing.id),updated:true,message:"Template updated in your library."})}const r=db.prepare("INSERT INTO message_templates(name,category,subject,body) VALUES(?,?,?,?)").run(name,category,subject,body);res.status(201).json({template:db.prepare("SELECT * FROM message_templates WHERE id=?").get(r.lastInsertRowid),message:"Template saved to your library."})});
app.patch("/api/admin/templates/:id",admin,(req,res)=>{const name=clean(req.body.name,100),category=clean(req.body.category,40),subject=clean(req.body.subject,160),body=clean(req.body.body,3000);if(!name||!category||!body)return res.status(400).json({error:"Template name, category and message are required."});const r=db.prepare("UPDATE message_templates SET name=?,category=?,subject=?,body=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(name,category,subject,body,Number(req.params.id));if(!r.changes)return res.status(404).json({error:"Template not found."});res.json({template:db.prepare("SELECT * FROM message_templates WHERE id=?").get(Number(req.params.id))})});
app.delete("/api/admin/templates/:id",admin,(req,res)=>{const r=db.prepare("DELETE FROM message_templates WHERE id=?").run(Number(req.params.id));if(!r.changes)return res.status(404).json({error:"Template not found."});res.json({ok:true})});
app.get("/api/admin/messages/ready",admin,(req,res)=>res.json({ids:db.prepare("SELECT id FROM messages WHERE delivery_status='manual_ready' ORDER BY id DESC LIMIT 500").all().map(row=>row.id)}));
app.get("/api/admin/messages",admin,(req,res)=>res.json({messages:db.prepare(`SELECT m.id,m.user_id,u.member_id,u.name,u.phone,m.subject,m.body,m.image_data,m.delivery_mode,m.scheduled_at,m.sent_at,m.status,m.delivery_status,m.delivery_error,m.template_id,m.provider_message_id,m.created_at,t.name AS template_name FROM messages m JOIN users u ON u.id=m.user_id LEFT JOIN message_templates t ON t.id=m.template_id ORDER BY m.id DESC LIMIT 500`).all()}));
app.post("/api/admin/messages/:id/complete",admin,(req,res)=>{const id=Number(req.params.id);if(!Number.isInteger(id)||id<1)return res.status(400).json({error:"Invalid reminder."});const result=db.prepare("UPDATE messages SET status='sent',sent_at=?,delivery_status='manual_sent',delivery_error='Marked complete manually; WhatsApp delivery was not verified.' WHERE id=? AND delivery_status='manual_ready' AND status='pending'").run(new Date().toISOString(),id);if(!result.changes)return res.status(409).json({error:"This reminder is no longer waiting to be marked complete. Refresh delivery history."});res.json({ok:true,message:"Reminder marked completed. WhatsApp delivery was not verified."})});
function whatsappConfigured(){return Boolean(process.env.WHATSAPP_ACCESS_TOKEN&&process.env.WHATSAPP_PHONE_NUMBER_ID)}
function whatsappPhone(value){let digits=String(value||'').replace(/\D/g,'');if(digits.length===10)digits='91'+digits;return digits.length>=11&&digits.length<=15?digits:''}
async function sendWhatsAppMessage(row,user){
  if(!whatsappConfigured())throw new Error('WhatsApp delivery is not configured. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID in the server .env file.');
  const to=whatsappPhone(user.phone);if(!to)throw new Error('Member phone number is not a valid international WhatsApp number.');
  const version=process.env.WHATSAPP_GRAPH_VERSION||'v22.0';const base=`https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}`;const headers={Authorization:`Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`};
  // Business-initiated messages outside the 24-hour customer-service window generally
  // require an approved template. Configure a template with one body variable ({{1}})
  // and set WHATSAPP_TEMPLATE_NAME + WHATSAPP_TEMPLATE_LANGUAGE to use it.
  let payload;
  if(process.env.WHATSAPP_TEMPLATE_NAME){
    payload={messaging_product:'whatsapp',to,type:'template',template:{name:process.env.WHATSAPP_TEMPLATE_NAME,language:{code:process.env.WHATSAPP_TEMPLATE_LANGUAGE||'en_US'},components:[{type:'body',parameters:[{type:'text',text:String(row.body).slice(0,1024)}]}]}};
  }else{
    payload={messaging_product:'whatsapp',recipient_type:'individual',to,type:'text',text:{preview_url:false,body:row.body}};
  }
  if(row.image_data){
    if(process.env.WHATSAPP_TEMPLATE_NAME) throw new Error('Image attachments with approved-template mode are not enabled. Send the template text first or disable template mode for recipients inside the 24-hour window.');
    const match=row.image_data.match(/^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/i);if(!match)throw new Error('The attached image is invalid. Please upload a PNG, JPG or WebP image.');
    const bytes=Buffer.from(match[2],'base64');const form=new FormData();form.append('messaging_product','whatsapp');form.append('file',new Blob([bytes],{type:match[1]}),'message-image');
    const upload=await fetch(`${base}/media`,{method:'POST',headers,...{body:form}});const ud=await upload.json().catch(()=>({}));if(!upload.ok||!ud.id)throw new Error(ud.error?.message||`WhatsApp image upload failed (${upload.status}).`);
    payload={messaging_product:'whatsapp',recipient_type:'individual',to,type:'image',image:{id:ud.id,caption:row.body}};
  }
  const response=await fetch(`${base}/messages`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.messages?.[0]?.id)throw new Error(data.error?.error_user_msg||data.error?.message||`WhatsApp rejected the message (${response.status}). Check opt-in, approved templates and the 24-hour messaging window.`);
  return data.messages[0].id;
}
async function deliverMessageById(id){
  const row=db.prepare("SELECT * FROM messages WHERE id=? AND status IN ('pending','scheduled')").get(id);if(!row)return {skipped:true};
  const user=db.prepare("SELECT id,name,member_id,plan,phone FROM users WHERE id=? AND role='member'").get(row.user_id);if(!user){db.prepare("UPDATE messages SET status='failed',delivery_error=? WHERE id=?").run('Recipient member no longer exists.',id);return {ok:false};}
  try{const providerId=await sendWhatsAppMessage(row,user);db.prepare("UPDATE messages SET status='sent',sent_at=?,delivery_error='',provider_message_id=?,delivery_status='sent' WHERE id=? AND status IN ('pending','scheduled')").run(new Date().toISOString(),providerId,id);return {ok:true};}
  catch(e){const message=String(e.message||'Delivery failed').slice(0,500);db.prepare("UPDATE messages SET status='failed',delivery_status='failed',delivery_error=? WHERE id=? AND status IN ('pending','scheduled')").run(message,id);console.error(`WhatsApp delivery failed for message ${id}: ${message}`);return {ok:false,error:message};}
}
app.post("/api/admin/messages/bulk",admin,async(req,res)=>{
 let ids=Array.isArray(req.body.user_ids)?[...new Set(req.body.user_ids.map(Number).filter(Number.isInteger))]:[],templateId=Number(req.body.template_id)||null,subject=clean(req.body.subject,160),body=clean(req.body.body,3000),image=clean(req.body.image_data,2500000),mode=clean(req.body.delivery_mode,20)||'manual',scheduled=clean(req.body.scheduled_at,80),audienceStatus=clean(req.body.audience_status,20),audiencePlan=clean(req.body.audience_plan,30),audienceSearch=clean(req.body.audience_search,120).toLowerCase();
 if(!body||!['manual','automatic','scheduled_selected'].includes(mode))return res.status(400).json({error:'Enter a message before sending.'});
 const isScheduled=mode!=='manual',isFilterSchedule=mode==='automatic';
 if(templateId&&!db.prepare('SELECT id FROM message_templates WHERE id=?').get(templateId))return res.status(400).json({error:'Selected message template is no longer available.'});
 if(image&&!/^data:image\/(png|jpe?g|webp);base64,/i.test(image))return res.status(400).json({error:'Please select a PNG, JPG or WebP image.'});
 if(isScheduled&&!scheduled)return res.status(400).json({error:'Choose a future date and time for scheduled delivery.'});
 if(isFilterSchedule){const where=["role='member'"],params=[];if(['active','pending','paused'].includes(audienceStatus)){where.push('status=?');params.push(audienceStatus)}if(['Basic','Premium','Elite'].includes(audiencePlan)){where.push('plan=?');params.push(audiencePlan)}if(audienceSearch){where.push("lower(name||' '||member_id||' '||phone||' '||coalesce(email,'')) LIKE ?");params.push(`%${audienceSearch}%`)}ids=db.prepare(`SELECT id FROM users WHERE ${where.join(' AND ')} ORDER BY id DESC`).all(...params).map(x=>x.id)}
 if(!ids.length)return res.status(400).json({error:isScheduled?'No members were selected or matched the audience filters.':'Select at least one member for manual sending.'});
 let scheduledAt=null,status='pending';if(isScheduled){const d=parseScheduledDate(scheduled);if(Number.isNaN(d.getTime())||d.getTime()<=Date.now())return res.status(400).json({error:'Choose a valid future date and time for scheduled delivery.'});scheduledAt=d.toISOString();status='scheduled';}
 const recipients=db.prepare(`SELECT id,name,phone FROM users WHERE role='member' AND id IN (${ids.map(()=>'?').join(',')})`).all(...ids),valid=recipients.map(x=>x.id);if(!valid.length)return res.status(400).json({error:'No valid member recipients were found.'});
 const missingPhones=recipients.filter(user=>!whatsappPhone(user.phone));if(missingPhones.length)return res.status(400).json({error:`Add a valid WhatsApp phone number with country code for: ${missingPhones.map(user=>user.name).join(', ')}.`});
 const stmt=db.prepare('INSERT INTO messages(user_id,template_id,subject,body,image_data,delivery_mode,scheduled_at,sent_at,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)');const inserted=[],storedMode=isScheduled?'automatic':'manual';
 const tx=db.transaction(()=>{for(const id of valid){const recipient=db.prepare('SELECT name,member_id,plan FROM users WHERE id=?').get(id);const finalBody=body.replace(/{{name}}/g,recipient.name).replace(/{{member_id}}/g,recipient.member_id).replace(/{{plan}}/g,recipient.plan).replace(/{{date}}/g,scheduledAt?new Date(scheduledAt).toLocaleDateString('en-IN'):new Date().toLocaleDateString('en-IN'));const r=stmt.run(id,templateId,subject,finalBody,image,storedMode,scheduledAt,null,status,req.user.id);inserted.push(Number(r.lastInsertRowid));}});tx();
 if(isScheduled){const audience=isFilterSchedule?'members matching your filters':'selected member';return res.status(201).json({count:inserted.length,status:'scheduled',message:`${inserted.length} reminder${inserted.length===1?'':'s'} scheduled for ${audience} at ${new Date(scheduledAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST. Keep the server running. When due, open WhatsApp from Delivery history and press Send. No WhatsApp API is used.`})}
 if(!whatsappConfigured()){db.prepare("UPDATE messages SET status='pending',delivery_status='manual_ready',delivery_error='Ready to send manually: open WhatsApp from Delivery history.' WHERE id IN ("+inserted.map(()=>'?').join(',')+")").run(...inserted);return res.status(202).json({count:inserted.length,status:'manual_ready',message:`${inserted.length} message${inserted.length===1?'':'s'} ready. Open WhatsApp from Delivery history and press Send. Messages are not sent automatically without WhatsApp API.`})}
 const results=[];for(const id of inserted)results.push(await deliverMessageById(id));const sent=results.filter(x=>x.ok).length,failed=results.filter(x=>x.ok===false).length;
 return res.status(201).json({count:inserted.length,sent,failed,status:failed?'partial': 'sent',message:failed?`${sent} sent; ${failed} failed. Open delivery history to see the exact error and retry after fixing it.`:`All ${sent} message${sent===1?'':'s'} accepted by WhatsApp.`});
});
app.post('/api/admin/messages/retry',admin,async(req,res)=>{const ids=Array.isArray(req.body.ids)?[...new Set(req.body.ids.map(Number).filter(Number.isInteger))]:[];if(!ids.length)return res.status(400).json({error:'Choose one or more failed or pending messages to retry.'});if(!whatsappConfigured())return res.status(503).json({error:'WhatsApp delivery is not configured. Add WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID first.'});const results=[];for(const id of ids){db.prepare("UPDATE messages SET status='pending',delivery_error='' WHERE id=? AND status IN ('failed','pending')").run(id);results.push(await deliverMessageById(id));}const sent=results.filter(x=>x.ok).length,failed=results.filter(x=>x.ok===false).length;res.json({sent,failed,message:`Retry finished: ${sent} sent, ${failed} failed.`});
});
app.get("/api/member/messages",auth,(req,res)=>{if(req.user.role!=="member")return res.status(403).json({error:"Member account required."});res.json({messages:db.prepare("SELECT id,subject,body,image_data,sent_at,created_at FROM messages WHERE user_id=? AND status='sent' ORDER BY id DESC LIMIT 100").all(req.user.id)})});

app.post("/api/admin/trainers",admin,(req,res)=>{const name=clean(req.body.name,100),specialty=clean(req.body.specialty,120),bio=clean(req.body.bio,1000),certifications=clean(req.body.certifications,300),photo=clean(req.body.photo_url,500),experience=Number(req.body.experience_years);if(name.length<2||specialty.length<2||bio.length<10||!Number.isInteger(experience)||experience<0||experience>60)return res.status(400).json({error:"Enter a name, specialty, bio and valid years of experience."});const r=db.prepare("INSERT INTO trainers(name,specialty,experience_years,bio,certifications,photo_url) VALUES(?,?,?,?,?,?)").run(name,specialty,experience,bio,certifications,photo);res.status(201).json({trainer:db.prepare("SELECT * FROM trainers WHERE id=?").get(r.lastInsertRowid)})});
app.delete("/api/admin/trainers/:id",admin,(req,res)=>{const r=db.prepare("UPDATE trainers SET active=0 WHERE id=?").run(Number(req.params.id));if(!r.changes)return res.status(404).json({error:"Trainer not found."});res.json({ok:true})});
app.get("/api/admin/enquiries",admin,(req,res)=>res.json({enquiries:db.prepare("SELECT e.*,u.member_id AS converted_member_id FROM enquiries e LEFT JOIN users u ON u.id=e.converted_user_id ORDER BY e.id DESC LIMIT 500").all(),fetched_at:new Date().toISOString()}));
app.patch("/api/admin/enquiries/:id",admin,async(req,res)=>{const id=Number(req.params.id),status=clean(req.body.status,20);if(!["new","contacted","closed"].includes(status))return res.status(400).json({error:"Invalid enquiry status."});const enquiry=db.prepare("SELECT * FROM enquiries WHERE id=?").get(id);if(!enquiry)return res.status(404).json({error:"Enquiry not found."});
if(status!=="closed"){db.prepare("UPDATE enquiries SET status=? WHERE id=?").run(status,id);return res.json({ok:true,status,message:"Enquiry status saved."});}
try{
  let userId=enquiry.converted_user_id||null,temporaryPassword="";
  if(!userId){
    const normalizedEmail=(enquiry.email||"").trim().toLowerCase();
    const existing=normalizedEmail?db.prepare("SELECT id FROM users WHERE role='member' AND lower(email)=? AND email NOT LIKE '%@member.local'").get(normalizedEmail):db.prepare("SELECT id FROM users WHERE role='member' AND phone=? ORDER BY id LIMIT 1").get(enquiry.phone);
    if(existing) userId=existing.id;
    else {
      const memberId=makeMemberId(); temporaryPassword=`Sibi@${Math.random().toString(36).slice(2,8).toUpperCase()}!`; const hash=await bcrypt.hash(temporaryPassword,12); const email=normalizeEmail(normalizedEmail,memberId); const r=db.prepare("INSERT INTO users(member_id,name,email,phone,address,password_hash,role,plan,status) VALUES(?,?,?,?,?,?,'member','Basic','pending')").run(memberId,enquiry.name,email,enquiry.phone,enquiry.place,hash); userId=Number(r.lastInsertRowid);
    }
  }
  db.prepare("UPDATE enquiries SET status='closed',converted_user_id=? WHERE id=?").run(userId,id); const member=db.prepare(`${memberSelect} AND u.id=?`).get(userId); res.json({ok:true,status:"closed",converted:true,member,temporaryPassword,message:temporaryPassword?"Enquiry closed and new member created successfully.":"Enquiry closed and linked to the existing member."});
}catch(e){console.error(e);res.status(500).json({error:"Could not close the enquiry and create the member."})}});
app.use(express.static(path.join(ROOT,"public"),{setHeaders:(res)=>{res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");res.setHeader("Pragma","no-cache");res.setHeader("Expires","0")}}));app.get("/",(req,res)=>res.sendFile(path.join(ROOT,"public","index.html")));
let schedulerBusy=false;
async function deliverScheduledMessages(){
  if(schedulerBusy)return;schedulerBusy=true;
  try{const result=db.prepare("UPDATE messages SET status='pending',delivery_status='manual_ready',delivery_error='Ready to send manually: open WhatsApp from Delivery history.' WHERE id IN (SELECT id FROM messages WHERE status='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at<=? ORDER BY scheduled_at,id LIMIT 50)").run(new Date().toISOString());if(result.changes)console.log(`${result.changes} scheduled reminder(s) ready for manual WhatsApp sending.`);}
  catch(e){console.error('Scheduled WhatsApp delivery worker error:',e)}finally{schedulerBusy=false}
}
setInterval(deliverScheduledMessages,SCHEDULE_POLL_INTERVAL_MS);deliverScheduledMessages();

(async()=>{try{await seedAdmin();app.listen(PORT,()=>console.log(`Sibi Sports Club running at http://localhost:${PORT}`));}catch(e){console.error("Startup failed:",e);process.exit(1)}})();
