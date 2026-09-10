/* Uses GitHub's Git Database API to publish one non-forced, atomic commit. */
const repoAPI='https://api.github.com/repos/mohsenkh83-cmd/tpj-tax-deadlines';
const branch='main';
let sessionToken='', snapshot=null, busy=false;
const byId=id=>document.getElementById(id);
const clone=x=>JSON.parse(JSON.stringify(x));
const asJSON=x=>JSON.stringify(x,null,2)+'\n';
function safeLink(value){try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.href:''}catch{return ''}}
function setBusy(value){busy=value;document.querySelectorAll('button,input,select,textarea').forEach(e=>e.disabled=value)}
async function api(path,method='GET',payload){
 const r=await fetch(repoAPI+path,{method,cache:'no-store',headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+sessionToken,'Content-Type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})});
 if(!r.ok){const e=new Error(r.status===401?'کلید دسترسی معتبر نیست.':r.status===403?'دسترسی نوشتن این مخزن مجاز نیست یا محدودیت درخواست فعال است.':r.status===409||r.status===422?'ثبت انجام نشد؛ احتمال تغییر هم‌زمان اطلاعات یا محدودیت شاخه وجود دارد. دوباره اطلاعات را دریافت کن.':'دریافت یا ثبت اطلاعات ناموفق بود ('+r.status+').');e.status=r.status;throw e}
 return r.json();
}
async function readText(path,sha,optional=false){
 try{const f=await api('/contents/'+path+'?ref='+sha);if(f.encoding!=='base64'||typeof f.content!=='string')throw Error('قالب فایل پشتیبانی نمی‌شود: '+path);return new TextDecoder().decode(Uint8Array.from(atob(f.content.replace(/\s/g,'')),c=>c.charCodeAt(0)))}
 catch(e){if(optional&&e.status===404)return null;throw e}
}
function validateCalendar(d){
 if(!d||typeof d!=='object'||!d.months||!Number.isInteger(d.defaultYear)||d.defaultYear<1300||d.defaultYear>1500)throw Error('ساختار تقویم معتبر نیست.');
 for(const [m,arr] of Object.entries(d.months)){if(!months.includes(m)||!Array.isArray(arr))throw Error('ساختار ماه‌های تقویم معتبر نیست.');for(const e of arr)if(!e||typeof e.title!=='string'||!e.title.trim()||e.day===undefined)throw Error('یک موعد عنوان یا روز معتبر ندارد.')}
}
async function loadSnapshot(){
 const ref=await api('/git/ref/heads/'+branch), sha=ref.object.sha;
 const commit=await api('/git/commits/'+sha);
 const files=await Promise.all(['monitor-state.json','deadlines.json','latest-updates.json','deadline-changes.json','index.html'].map((p,i)=>readText(p,sha,i===2||i===3)));
 const state=JSON.parse(files[0]), calendar=JSON.parse(files[1]), latest=files[2]?JSON.parse(files[2]):{items:[]}, log=files[3]?JSON.parse(files[3]):{changes:[]};
 validateCalendar(calendar);
 if(!state||typeof state!=='object'||Array.isArray(state)||!Array.isArray(latest.items)||!Array.isArray(log.changes))throw Error('ساختار فایل‌های خبر معتبر نیست.');
 if(state.review_version!==1||!state.review||typeof state.review!=='object'||Array.isArray(state.review))throw Error('پایشگر جدید هنوز اجرا نشده است؛ ابتدا monitor.py جدید را نصب و پایش را اجرا کن.');
 snapshot={sha,tree:commit.tree.sha,state,calendar,latest,log,index:files[4]};
 data=clone(calendar);clearForm();syncControls();render();renderQueue();
 byId('connectionStatus').textContent='متصل · اطلاعات از آخرین نسخه مخزن دریافت شد.';
}
async function commitFiles(files,message){
 if(!snapshot||!sessionToken)throw Error('ابتدا اتصال را برقرار کن.');
 const ref=await api('/git/ref/heads/'+branch);
 if(ref.object.sha!==snapshot.sha)throw Error('اطلاعات سایت از زمان دریافت تغییر کرده است. دوباره اتصال و دریافت را بزن و تصمیم را بررسی کن.');
 const tree=await api('/git/trees','POST',{base_tree:snapshot.tree,tree:Object.entries(files).map(([path,content])=>({path,mode:'100644',type:'blob',content}))});
 const commit=await api('/git/commits','POST',{message,tree:tree.sha,parents:[snapshot.sha]});
 await api('/git/refs/heads/'+branch,'PATCH',{sha:commit.sha,force:false});
 // No success is shown before the branch update is acknowledged.
 return commit.sha;
}
function renderQueue(){
 const pending=Object.values(snapshot.state.review).filter(i=>i.status==='pending').sort((a,b)=>(b.discovered_at||'').localeCompare(a.discovered_at||''));
 byId('pendingCount').textContent='('+pending.length+')';
 byId('reviewList').replaceChildren();
 if(!pending.length){byId('reviewList').textContent='خبری در انتظار بررسی نیست.';return}
 for(const item of pending){
 const id=item.review_id;if(!/^[a-f0-9]{64}$/.test(id))continue;
 const card=document.createElement('article');card.className='review-card';
 const link=safeLink(item.link), suggestion=item.suggestion||{};
 const date=suggestion.deadline||{};
 const options=[];
 for(const month of months)(snapshot.calendar.months[month]||[]).forEach((e,i)=>options.push(`<option value="${months.indexOf(month)}:${i}">${esc(e.title)} — ${esc(e.period)} — ${esc(e.day)} ${esc(month)}</option>`));
 card.innerHTML=`<h3>${esc(item.source)}</h3><div class="meta">${esc(item.date||'تاریخ انتشار مشخص نیست')}</div>
 ${link?`<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">بازکردن خبر اصلی</a>`:''}
 <label for="text-${id}">متن قابل انتشار — امکان ویرایش</label><textarea id="text-${id}">${esc(item.text)}</textarea>
 <details><summary>اصلاح موعد همراه با انتشار</summary>
 <label for="target-${id}">موعد و دوره‌ای که باید تغییر کند</label><select id="target-${id}"><option value="">خودت موعد مرتبط را انتخاب کن</option>${options.join('')}</select>
 <div class="old-date" id="old-${id}">هنوز موعدی انتخاب نشده است.</div>
 <div class="form-grid"><div><label for="month-${id}">ماه جدید</label><select id="month-${id}">${months.map(m=>`<option ${m===date.month?'selected':''}>${m}</option>`).join('')}</select></div>
 <div><label for="day-${id}">روز جدید</label><input id="day-${id}" inputmode="numeric" value="${esc(date.day||'')}"></div>
 <div><label for="year-${id}">سال موعد (باید با سال تقویم برابر باشد)</label><input id="year-${id}" inputmode="numeric" value="${esc(date.year||snapshot.calendar.defaultYear)}"></div></div>
 <p>تاریخ پیشنهادی از متن استخراج شده؛ دوره و تاریخ را با خبر اصلی تطبیق بده.</p>
 <label><input type="checkbox" style="width:auto" id="confirmed-${id}"> دوره، سال و تاریخ جدید را بررسی کردم.</label></details>
 <div class="actions"><button data-action="publish" class="primary">فقط انتشار خبر</button><button data-action="apply">انتشار و اعمال تاریخ</button><button data-action="reject" class="danger">رد خبر</button></div>`;
 card.querySelector('select').onchange=()=>{
 const v=byId('target-'+id).value;byId('confirmed-'+id).checked=false;
 if(!v){byId('old-'+id).textContent='هنوز موعدی انتخاب نشده است.';return}
 const [mi,i]=v.split(':').map(Number),e=snapshot.calendar.months[months[mi]][i];
 byId('old-'+id).textContent=`موعد فعلی: ${e.day} ${months[mi]} ${snapshot.calendar.defaultYear} · ${e.title} · ${e.period||''}`;
 };
 card.querySelectorAll('button[data-action]').forEach(b=>b.onclick=()=>decide(id,b.dataset.action));
 byId('reviewList').append(card);
 for(const field of ['month','day','year'])byId(field+'-'+id).onchange=()=>byId('confirmed-'+id).checked=false;
 }
}
function numberFa(v){return Number(String(v).replace(/[۰-۹]/g,c=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(c)))}
function validDay(year,monthIndex,day){
 if(!Number.isInteger(day)||day<1||day>31)return false;
 // Validate Esfand against the runtime's Persian calendar, including leap years.
 const fmt=new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn',{year:'numeric',month:'numeric',day:'numeric',timeZone:'UTC'});
 const start=Date.UTC(year+621,1,15);
 for(let d=0;d<410;d++){const p=Object.fromEntries(fmt.formatToParts(new Date(start+d*86400000)).map(x=>[x.type,x.value]));if(+p.year===year&&+p.month===monthIndex+1&&+p.day===day)return true}
 return false;
}
function applyDecision(base,id,action,text,target,newDate,now){
 const next=clone(base),item=next.state.review[id];
 if(!item||item.status!=='pending')throw Error('این خبر دیگر در انتظار بررسی نیست.');
 if(!['publish','apply','reject'].includes(action))throw Error('تصمیم نامعتبر است.');
 if(action!=='reject'&&!text.trim())throw Error('متن خبر خالی است.');
 if(action==='apply'){
  const {month,index}=target||{},event=next.calendar.months[month]?.[index];
  if(!event)throw Error('موعد مرتبط را انتخاب کن.');
  if(newDate.year!==next.calendar.defaultYear)throw Error('سال خبر با تقویم فعلی برابر نیست. برای این مورد ابتدا سال و دوره را بررسی کن.');
  if(!months.includes(newDate.month)||!validDay(newDate.year,months.indexOf(newDate.month),newDate.day))throw Error('روز یا ماه جدید معتبر نیست.');
  const old={month,day:event.day,year:next.calendar.defaultYear};
  const updated={...event,day:newDate.day,source:safeLink(item.link),updated_at_utc:now,previous_deadline:old};
  next.calendar.months[month].splice(index,1);(next.calendar.months[newDate.month]??=[]).push(updated);
  next.calendar.months[newDate.month].sort((a,b)=>(numberFa(a.day)||99)-(numberFa(b.day)||99));
  next.log.changes.push({applied_at_utc:now,review_id:id,task:event.title,period:event.period||'',old_deadline:old,new_deadline:newDate,source:item.source,source_link:item.link,source_text:item.text,approved_text:text});
 }
 item.status=action==='reject'?'rejected':action==='apply'?'approved_applied':'approved';
 item.reviewed_at=now;item.approved_text=action==='reject'?'':text;
 if(action!=='reject'){
  next.latest.items=next.latest.items.filter(i=>i.review_id!==id&&(!item.link||i.link!==item.link));
  next.latest.items.unshift({source:item.source,date:item.date||'',link:safeLink(item.link),text,review_id:id,approved_at:now});
  next.latest.items=next.latest.items.slice(0,30);next.latest.last_check_utc=now;
 }
 return next;
}
async function decide(id,action){
 if(busy||!snapshot)return;
 try{
 if(asJSON(data)!==asJSON(snapshot.calendar))throw Error('ویرایش ذخیره‌نشده در تقویم داری؛ ابتدا آن را ثبت کن یا دوباره اطلاعات را دریافت کن.');
 const value=byId('target-'+id).value,parts=value.split(':').map(Number);
 const target=value?{month:months[parts[0]],index:parts[1]}:null;
 const newDate={month:byId('month-'+id).value,day:numberFa(byId('day-'+id).value),year:numberFa(byId('year-'+id).value)};
 if(action==='apply'&&!byId('confirmed-'+id).checked)throw Error('ابتدا دوره و تاریخ جدید را بررسی و تیک تأیید را فعال کن.');
 const next=applyDecision(snapshot,id,action,byId('text-'+id).value.trim(),target,newDate,new Date().toISOString());
 const message=action==='reject'?'خبر رد شود؟':action==='apply'?`خبر منتشر و موعد انتخاب‌شده به ${newDate.day} ${newDate.month} ${newDate.year} تغییر کند؟`:'این متن در اخبار سایت منتشر شود؟';
 if(!confirm(message))return;
 setBusy(true);
 const files={'monitor-state.json':asJSON(next.state)};
 if(action!=='reject')files['latest-updates.json']=asJSON(next.latest);
 if(action==='apply'){files['deadlines.json']=asJSON(next.calendar);files['deadline-changes.json']=asJSON(next.log)}
 await commitFiles(files,'TPJ review: '+action+' '+id.slice(0,12));
 await refreshAfterSuccess();
 }catch(e){byId('connectionStatus').textContent=e.message;notify(e.message,false)}finally{setBusy(false)}
}
async function refreshAfterSuccess(){
 snapshot=null;
 byId('reviewList').textContent='تصمیم ثبت شد؛ دریافت آخرین اطلاعات…';
 byId('connectionStatus').textContent='ثبت در GitHub انجام شد؛ نمایش عمومی پس از انتشار GitHub Pages به‌روز می‌شود.';
 try{await loadSnapshot();byId('connectionStatus').textContent='ثبت در GitHub انجام شد. برای نمایش عمومی منتظر تکمیل انتشار GitHub Pages بمان.';notify('تصمیم ثبت شد')}catch(e){byId('connectionStatus').textContent='ثبت انجام شد، اما دریافت مجدد ناموفق بود. دوباره اتصال و دریافت را بزن.'}
}
byId('connect').onclick=async()=>{
 if(busy)return;
 if(snapshot&&!confirm('اطلاعات دوباره دریافت شود؟ ویرایش‌های ذخیره‌نشده کنار گذاشته می‌شوند.'))return;
 sessionToken=byId('accessToken').value.trim()||sessionToken;byId('accessToken').value='';
 if(!sessionToken){notify('کلید دسترسی همین مخزن را وارد کن.',false);return}
 setBusy(true);try{await loadSnapshot()}catch(e){snapshot=null;byId('connectionStatus').textContent=e.message;byId('reviewList').textContent='دریافت صف بررسی انجام نشد.'}finally{setBusy(false)}
};
byId('disconnect').onclick=()=>{sessionToken='';snapshot=null;byId('accessToken').value='';byId('reviewList').textContent='اتصال قطع شد.';byId('connectionStatus').textContent='متصل نیست';byId('pendingCount').textContent=''};
byId('publishCalendar').onclick=async()=>{
 if(busy)return;
 try{if(!snapshot)throw Error('ابتدا اتصال را برقرار کن.');validateCalendar(data);if(!confirm('ویرایش‌های فعلی تقویم روی سایت ثبت شوند؟'))return;setBusy(true);await commitFiles({'deadlines.json':asJSON(data)},'TPJ: approved manual calendar edits');await refreshAfterSuccess()}catch(e){notify(e.message,false);byId('connectionStatus').textContent=e.message}finally{setBusy(false)}
};
const emailButton=document.createElement('button');emailButton.textContent='ثبت ایمیل جدید شرکت در صفحه اصلی';
byId('connection').append(emailButton);
emailButton.onclick=async()=>{
 if(busy)return;
 try{if(!snapshot)throw Error('ابتدا اتصال را برقرار کن.');const old='tarazpardazanjavan@gmail.com',email='tpjarvand@gmail.com';
 if(!snapshot.index.includes(old)){notify(snapshot.index.includes(email)?'ایمیل جدید از قبل ثبت شده است.':'ایمیل قبلی در صفحه اصلی پیدا نشد.',snapshot.index.includes(email));return}
 if(!confirm('ایمیل صفحه اصلی به '+email+' تغییر کند؟'))return;
 setBusy(true);await commitFiles({'index.html':snapshot.index.split(old).join(email)},'TPJ: update company contact email');await refreshAfterSuccess();
 }catch(e){notify(e.message,false);byId('connectionStatus').textContent=e.message}finally{setBusy(false)}
};
