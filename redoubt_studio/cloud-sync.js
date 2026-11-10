/* Re:doubt v8 cloud synchronization. Browser-only Supabase publishable key; never use a secret key. */
(()=>{'use strict';
const $=id=>document.getElementById(id), CONFIG_KEY='redoubt-cloud-config-v1';
let client=null,user=null,version=null,timer=null,busy=false,pending=false,paused=false,initializing=false;
let config;try{config=JSON.parse(localStorage.getItem(CONFIG_KEY)||'null')}catch{}
const setStatus=(message,kind='')=>{$('cloudStatus').textContent=message;$('cloudDot').className='cloudDot '+kind};
const showControls=()=>{const yes=!!user;$('cloudSignIn').textContent=yes?'Account settings':'Connect cloud';$('cloudSyncNow').hidden=!yes;$('cloudHistory').hidden=!yes;$('cloudSignOut').hidden=!yes};
function suspend(flag){paused=flag}
function schedule(){if(paused||!user||initializing)return;pending=true;setStatus('Changes waiting to sync','busy');clearTimeout(timer);timer=setTimeout(()=>void sync(),1400)}
window.redoubtCloud={schedule,suspend};
function snapshot(){return window.redoubtCloudSnapshot()}
function replace(data){window.redoubtCloudApply(data)}
function parseError(err){return err?.message||String(err)}
function openDialog(){if(config){$('cloudUrl').value=config.url||'';$('cloudKey').value=config.key||'';$('cloudEmail').value=config.email||''}$('cloudPassword').value='';$('cloudDialogMessage').textContent='';$('cloudDialog').showModal()}
$('cloudSignIn').onclick=openDialog;
$('cloudCancel').onclick=()=>$('cloudDialog').close();
async function prepareCredentials(){
 const url=$('cloudUrl').value.trim().replace(/\/$/,''),key=$('cloudKey').value.trim(),email=$('cloudEmail').value.trim();
 if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url))throw Error('Enter a valid Supabase project URL.');
 if(!key||!email)throw Error('Enter your publishable key and email.');
 if(key.startsWith('sb_secret_')||key.includes('service_role'))throw Error('Never enter a secret or service_role key.');
 if(config?.url!==url||config?.key!==key){if(client){await client.auth.signOut();client=null;user=null;version=null}config={url,key,email};localStorage.setItem(CONFIG_KEY,JSON.stringify(config));await initClient()}
 else{config={url,key,email};localStorage.setItem(CONFIG_KEY,JSON.stringify(config));if(!client)await initClient()}
 if(!client)throw Error('Supabase library unavailable. Check your connection or Brave Shields.');
 return email;
}
async function performSignIn(method){
 const message=$('cloudDialogMessage'),password=$('cloudPassword').value;
 message.textContent='Connecting…';$('cloudSend').disabled=true;$('cloudPasswordSignIn').disabled=true;
 try{
  const email=await prepareCredentials();
  if(method==='password'){
   if(!password)throw Error('Enter your account password.');
   const {data,error}=await client.auth.signInWithPassword({email,password});
   if(error)throw error;
   if(!data?.session)throw Error('Sign-in not complete. Check that the user is confirmed in Supabase.');
   message.textContent='Signed in. Cloud synchronization is initializing.';
   await onSession(data.session);
   $('cloudDialog').close();
  }else{
   const {error}=await client.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname,shouldCreateUser:false}});
   if(error)throw error;
   message.textContent='Sign-in link sent. Open the email in this same Brave profile, then return here.';
  }
 }catch(e){message.textContent='Sign-in failed: '+parseError(e)}
 finally{$('cloudSend').disabled=false;$('cloudPasswordSignIn').disabled=false;$('cloudPassword').value=''}
}
$('cloudSend').onclick=()=>void performSignIn('email');
$('cloudPasswordSignIn').onclick=()=>void performSignIn('password');
$('cloudPassword').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();void performSignIn('password')}});
$('cloudSignOut').onclick=async()=>{if(!confirm('Sign out of cloud sync? Local shows will remain on this computer.'))return;clearTimeout(timer);if(client)await client.auth.signOut();user=null;version=null;pending=false;setStatus('Local only — signed out');showControls()};
$('cloudSyncNow').onclick=()=>void sync();
async function readRemote(){const {data,error}=await client.from('studio_state').select('data,version').eq('user_id',user.id).maybeSingle();if(error)throw error;return data}
async function chooseInitial(remote){if(!remote){version=0;pending=true;setStatus('First cloud backup queued…','busy');setTimeout(()=>void sync(),0);return}
const local=snapshot(),same=JSON.stringify(local)===JSON.stringify(remote.data);
if(same){version=remote.version;pending=false;setStatus('Cloud synced','ok');return}
// Never silently replace existing browser data or cloud data on first connection.
const useCloud=confirm('Cloud data already exists and differs from this browser.\n\nOK = Load cloud data into this browser.\nCancel = Keep browser data and review before replacing cloud data.\n\nExport a JSON backup first if you are unsure.');
if(useCloud){replace(remote.data);version=remote.version;pending=false;setStatus('Loaded from cloud','ok')}
else{version=remote.version;pending=false;setStatus('Cloud differs — browser kept; Sync now to choose overwrite','bad')}
}
async function sync(){if(!user||paused||initializing)return;if(busy){pending=true;return}busy=true;clearTimeout(timer);try{
const remote=await readRemote();if(version===null){await chooseInitial(remote);return}
if(remote&&remote.version!==version){const overwrite=confirm('Cloud data changed since this browser last synced.\n\nOK = Replace cloud data with this browser\'s shows.\nCancel = Load cloud data into this browser.\n\nExport a JSON backup before overwriting if unsure.');if(!overwrite){replace(remote.data);version=remote.version;pending=false;setStatus('Loaded latest cloud data','ok');return}version=remote.version}
if(!pending){pending=true;/* Explicit Sync now should upload browser state after a declined first-login merge. */}
const data=snapshot(),base=version;
setStatus('Syncing to cloud…','busy');pending=false;
const {data:newVersion,error}=await client.rpc('save_studio_state',{expected_version:base,new_data:data});
if(error)throw error;version=Number(newVersion);setStatus('Cloud synced','ok')
}catch(e){pending=true;setStatus('Sync failed — local changes kept: '+parseError(e),'bad')}
finally{busy=false;if(pending&&user&&!initializing){clearTimeout(timer);/* retry only when user makes another change or presses Sync now */}}
}
async function onSession(session){if(!session){user=null;version=null;showControls();setStatus('Local only — sign in to enable cloud backup');return}const next=session.user;if(user?.id===next.id)return;user=next;version=null;showControls();initializing=true;setStatus('Checking cloud data…','busy');try{const remote=await readRemote();initializing=false;await chooseInitial(remote)}catch(e){initializing=false;setStatus('Cloud setup needed: '+parseError(e),'bad')}}
async function initClient(){if(!config?.url||!config?.key)return;if(!window.supabase?.createClient){setStatus('Supabase library did not load. Check Brave Shields or connection.','bad');return}client=window.supabase.createClient(config.url,config.key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});client.auth.onAuthStateChange((event,session)=>{setTimeout(()=>void onSession(session),0)});const {data,error}=await client.auth.getSession();if(error)throw error;await onSession(data.session)}
$('cloudHistory').onclick=async()=>{if(!user)return;$('cloudSnapshots').textContent='Loading…';$('cloudHistoryDialog').showModal();try{const {data,error}=await client.from('studio_snapshots').select('id,version,created_at').eq('user_id',user.id).order('id',{ascending:false}).limit(30);if(error)throw error;$('cloudSnapshots').innerHTML='';for(const item of data){const row=document.createElement('div');row.className='snapshotItem';const label=document.createElement('div');label.textContent='Version '+item.version;const small=document.createElement('small');small.textContent=new Date(item.created_at).toLocaleString();label.append(document.createElement('br'),small);const btn=document.createElement('button');btn.textContent='Restore';btn.onclick=()=>void restoreSnapshot(item.id);row.append(label,btn);$('cloudSnapshots').append(row)}if(!data.length)$('cloudSnapshots').textContent='No snapshots yet.'}catch(e){$('cloudSnapshots').textContent='Could not load snapshots: '+parseError(e)}};
$('cloudHistoryClose').onclick=()=>$('cloudHistoryDialog').close();
async function restoreSnapshot(id){if(!confirm('Restore this older snapshot? Your current state will be replaced locally and in the cloud. Export a JSON backup first if you want to preserve it.'))return;try{const {data,error}=await client.from('studio_snapshots').select('data').eq('user_id',user.id).eq('id',id).single();if(error)throw error;replace(data.data);pending=true;$('cloudHistoryDialog').close();await sync()}catch(e){setStatus('Restore failed: '+parseError(e),'bad')}}
if(config){void initClient().catch(e=>setStatus('Cloud connection error: '+parseError(e),'bad'))}else setStatus('Local only — connect cloud to enable backup');
})();
