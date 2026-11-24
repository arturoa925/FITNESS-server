const B=process.env.BASE_URL||'http://localhost:3004'; let pass=0, fail=0;
const ok=(n,c,extra)=>{ if(c){pass++;console.log('PASS',n)} else {fail++;console.log('FAIL',n,extra??'')} };
const call=async(m,path,{token,body}={})=>{
  const r=await fetch(B+path,{method:m,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined,redirect:'manual'});
  let j=null; try{j=await r.json()}catch{} return {s:r.status,j,h:r.headers};
};
(async()=>{
  const sfx=Date.now();
  const a=await call('POST','/users/register',{body:{firstName:'A',lastName:'A',email:`a${sfx}@x.com`,password:'password-A-1'}});
  const b=await call('POST','/users/register',{body:{firstName:'B',lastName:'B',email:`b${sfx}@x.com`,password:'password-B-1'}});
  ok('register 201',a.s===201&&b.s===201,[a.s,JSON.stringify(a.j)]);
  ok('register response has no password',!('password' in a.j.user));
  const A={id:a.j.user.id,t:a.j.token}, Bu={id:b.j.user.id,t:b.j.token};

  const l=await call('POST','/users/login',{body:{email:`a${sfx}@x.com`,password:'password-A-1'}});
  ok('login after register works (no double hash)',l.s===200,[l.s,JSON.stringify(l.j)]);
  ok('login response has no password hash',l.j&&l.j.user&&!('password' in l.j.user));
  const bad=await call('POST','/users/login',{body:{email:`a${sfx}@x.com`,password:'nope-nope-1'}});
  ok('wrong password 400',bad.s===400);
  const seedLogin=await call('POST','/users/login',{body:{email:'arturo.ayala@example.com',password:'TrainHard123!'}});
  ok('seeded user login works',seedLogin.s===200,seedLogin.s);

  // auth status codes
  ok('no token -> 401',(await call('GET','/users/me')).s===401);
  ok('garbage token -> 401',(await call('GET','/users/me',{token:'abc'})).s===401);
  ok('/users/me works',(await call('GET','/users/me',{token:A.t})).j?.id===A.id);
  ok('GET /users (list) gone',(await call('GET','/users')).s===404);
  ok('GET /users/:id unauthenticated blocked',(await call('GET','/users/'+A.id)).s===401);

  // IDOR
  for (const [m,p,body] of [
    ['GET',`/users/${A.id}`],['GET',`/users/${A.id}/calendar`],['GET',`/users/${A.id}/calendar/foods`],
    ['POST',`/users/${A.id}/calendar/foods`,{date:'2026-01-01',food:{name:'x'}}],
    ['DELETE',`/users/${A.id}/calendar/foods`,{date:'2026-01-01',foodId:'1'}],
    ['GET',`/users/${A.id}/training-programs`],['PUT',`/users/${A.id}/program/update`,{name:'pwn'}],
    ['PUT',`/users/${A.id}`,{firstName:'pwn'}],['GET',`/users/${A.id}/daily-workout`],
    ['POST',`/users/${A.id}/program/choose`,{programId:'11111111-1111-4111-8111-111111111111'}],
  ]) { const r=await call(m,p,{token:Bu.t,body}); ok(`IDOR blocked ${m} ${p.replace(A.id,':A')}`,r.s===403,r.s); }

  // programs
  const tpl=await call('GET','/users/training-programs');
  ok('templates listed',tpl.s===200&&tpl.j.length>0&&tpl.j.every(p=>!p.userId),tpl.s);
  const T=tpl.j[0];
  const sw=await call('PUT',`/users/${A.id}/program/update`,{token:A.t,body:{programId:T.id}});
  ok('A can assign template',sw.s===201,[sw.s,JSON.stringify(sw.j)]);
  const tpl2=await call('GET','/users/training-programs');
  ok('personal copy NOT in public template list',tpl2.j.every(p=>!p.userId)&&tpl2.j.length===tpl.j.length);
  const aRow=sw.j.program.id;
  const steal=await call('PUT',`/users/${Bu.id}/program/update`,{token:Bu.t,body:{programId:aRow}});
  ok("B cannot copy A's personal program as template",steal.s===404,steal.s);
  const steal2=await call('POST',`/users/${Bu.id}/program/choose`,{token:Bu.t,body:{programId:aRow}});
  ok("B cannot choose A's personal program",steal2.s===404,steal2.s);
  const wk=T.workouts?.[0]; 
  const comp=await call('POST',`/users/${A.id}/program/complete`,{token:A.t,body:{programId:aRow,workoutId:'w:0-0-0',date:'2026-02-03',notes:'good'}});
  ok('complete workout',[200,404].includes(comp.s),[comp.s,JSON.stringify(comp.j)]);
  ok('complete rejects bad date',(await call('POST',`/users/${A.id}/program/complete`,{token:A.t,body:{programId:aRow,workoutId:'w:0-0-0',date:'2026-02-31'}})).s===400);
  ok('program patch rejects bad duration',(await call('PUT',`/users/${A.id}/program/update`,{token:A.t,body:{duration:'abc'}})).s===400);
  // pool leak check: provoke several 500s/400s then ensure server still responsive
  for(let i=0;i<8;i++) await call('PUT',`/users/${A.id}/program/update`,{token:A.t,body:{duration:'abc'}});
  ok('server responsive after repeated errors (no tx leak)',(await call('GET','/users/me',{token:A.t})).s===200);

  // foods concurrency
  const d='2026-03-04';
  await Promise.all(Array.from({length:12},(_,i)=>call('POST',`/users/${A.id}/calendar/foods`,{token:A.t,body:{date:d,food:{name:'f'+i,calories:i}}})));
  const foods=await call('GET',`/users/${A.id}/calendar/foods?date=${d}`,{token:A.t});
  ok('12 concurrent food adds all persisted',foods.j.length===12,foods.j.length);
  const cal=await call('GET',`/users/${A.id}/calendar?date=${d}`,{token:A.t});
  ok('single calendar row for day (no duplicates)',cal.j.length===1,cal.j.length);
  const del=await call('DELETE',`/users/${A.id}/calendar/foods`,{token:A.t,body:{date:d,foodId:foods.j[0].id}});
  ok('food delete',del.s===200&&del.j.foods.length===11);
  ok('bad date -> 400 not 500',(await call('GET',`/users/${A.id}/calendar/foods?date=garbage`,{token:A.t})).s===400);
  ok('bad from/to -> 400',(await call('GET',`/users/${A.id}/calendar?from=a&to=b`,{token:A.t})).s===400);
  ok('bad month -> 400',(await call('GET',`/users/${A.id}/calendar?month=13&year=2026`,{token:A.t})).s===400);
  ok('good month works',(await call('GET',`/users/${A.id}/calendar?month=3&year=2026`,{token:A.t})).s===200);
  ok('oversized food rejected',(await call('POST',`/users/${A.id}/calendar/foods`,{token:A.t,body:{date:d,food:{blob:'x'.repeat(20000)}}})).s===400);

  // profile / password
  ok('pw change without current pw blocked',(await call('PUT',`/users/${A.id}`,{token:A.t,body:{password:'new-password-1'}})).s===403);
  ok('pw change wrong current pw blocked',(await call('PUT',`/users/${A.id}`,{token:A.t,body:{password:'new-password-1',currentPassword:'zzzzzzzzz'}})).s===403);
  const pc=await call('PUT',`/users/${A.id}`,{token:A.t,body:{password:'new-password-1',currentPassword:'password-A-1'}});
  ok('pw change with current pw ok',pc.s===200&&!('password' in pc.j),pc.s);
  ok('login with NEW password works (no double hash)',(await call('POST','/users/login',{body:{email:`a${sfx}@x.com`,password:'new-password-1'}})).s===200);
  ok('old password rejected',(await call('POST','/users/login',{body:{email:`a${sfx}@x.com`,password:'password-A-1'}})).s===400);
  ok('email in use -> 409',(await call('PUT',`/users/${A.id}`,{token:A.t,body:{email:`b${sfx}@x.com`}})).s===409);
  ok('javascript: avatar url rejected',(await call('PUT',`/users/${A.id}`,{token:A.t,body:{profilePictureUrl:'javascript:alert(1)'}})).s===400);
  ok('https avatar url accepted',(await call('PUT',`/users/${A.id}`,{token:A.t,body:{profilePictureUrl:'https://img.example.com/a.png'}})).s===200);
  ok('register without names -> 400',(await call('POST','/users/register',{body:{email:`c${sfx}@x.com`,password:'password-C-1'}})).s===400);

  // AI route
  ok('AI route ignores body userId, 503 w/o key',(await call('POST','/users/ai/daily-workout',{token:A.t,body:{userId:Bu.id}})).s===503);
  ok('AI bad date 400',(await call('POST','/users/ai/daily-workout',{token:A.t,body:{date:'x'}})).s===400);
  ok('AI unauthenticated 401',(await call('POST','/users/ai/daily-workout',{body:{}})).s===401);

  // OAuth
  const evil=await call('GET','/auth/google?debug=true&state=mobile&redirect_uri='+encodeURIComponent('https://evil.example/steal'));
  ok('OAuth open redirect rejected',evil.s===400,[evil.s,JSON.stringify(evil.j)]);
  const evil2=await call('GET','/auth/github?debug=true&state=mobile&redirect_uri='+encodeURIComponent('javascript:alert(1)'));
  ok('OAuth js: redirect rejected',evil2.s===400);
  const good=await call('GET','/auth/google?debug=true&state=mobile&redirect_uri='+encodeURIComponent('exp://192.168.1.68:8081/--/x'));
  ok('OAuth exp:// redirect allowed in dev',good.s===200&&good.j.params.state.split('.').length===3,good.s);
  const app=await call('GET','/auth/github?debug=true&state=mobile&redirect_uri='+encodeURIComponent('arturofit://oauth-complete'));
  ok('OAuth arturofit:// allowed + user:email scope forced',app.s===200&&app.j.params.scope.includes('user:email'));
  ok('forged state rejected',(await call('GET','/auth/google/callback?code=x&state=mobile%7Credir%3Dhttps%3A%2F%2Fevil')).s===400);
  ok('access token cannot be used as state',(await call('GET','/auth/google/callback?code=x&state='+A.t)).s===400);
  const st=good.j.params.state;
  ok('oauth state cannot be used as API token',(await call('GET','/users/me',{token:st})).s===401);
  ok('CORS: evil origin gets no ACAO header',!(await fetch(B+'/users/training-programs',{headers:{origin:'https://evil.example'}})).headers.get('access-control-allow-origin'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
