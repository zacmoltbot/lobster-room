// UI build stamp (bump this when you deploy so we can confirm which frontend is running).
    const UI_VERSION = 'feed-v3-20260314';

    const STATES = [
      {key:'reply', cls:'b-reply', label:'💬 replying'},
      {key:'think', cls:'b-think', label:'🧠 thinking'},
      {key:'tool',  cls:'b-tool',  label:'🔧 tool'},
      {key:'build', cls:'b-build', label:'🏗️ building'},
      {key:'wait',  cls:'b-wait',  label:'⏳ idle'},
      {key:'err',   cls:'b-err',   label:'⚠️ error'},
    ];

    // State model for the room.
    const MODEL = {
      agents: [],
      pollMs: 2000,
      _pollMsLast: null,
      lastZoneFocus: null,
      layout: null,
      activity: null,
      selfName: null,
      tiles: null,
      manualMap: null,
      manualReady: false,
      nodeById: null,
    };

    async function apiGetJson(path){
      const r = await fetch(path, {cache:'no-store'});
      if(!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    }
    async function apiPostJson(path, body){
      const r = await fetch(path, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)});
      if(!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json().catch(()=>({ok:true}));
    }

    // ---------------- Movement debug instrumentation ----------------
    const MVDBG = {
      // Panel visibility (UI affordance). Default off.
      visible: false,
      enabled: false,
      freezeRoam: false,
      panelOpen: true,
      overlayOn: false,
      lastValidate: null,
      log: [],
      max: 160,
      _t0: 0,
    };

    function mvLoadPrefs(){
      try{ MVDBG.visible = localStorage.getItem('lobsterRoom.mvdbg.visible')==='1'; }catch{}
      try{ MVDBG.enabled = localStorage.getItem('lobsterRoom.mvdbg.enabled')==='1'; }catch{}
      try{ MVDBG.freezeRoam = localStorage.getItem('lobsterRoom.mvdbg.freeze')==='1'; }catch{}
      try{ MVDBG.panelOpen = localStorage.getItem('lobsterRoom.mvdbg.open')!=='0'; }catch{}
      try{ MVDBG.overlayOn = localStorage.getItem('lobsterRoom.mvdbg.overlay')==='1'; }catch{}
    }

    function mvSavePrefs(){
      try{ localStorage.setItem('lobsterRoom.mvdbg.visible', MVDBG.visible?'1':'0'); }catch{}
      try{ localStorage.setItem('lobsterRoom.mvdbg.enabled', MVDBG.enabled?'1':'0'); }catch{}
      try{ localStorage.setItem('lobsterRoom.mvdbg.freeze', MVDBG.freezeRoam?'1':'0'); }catch{}
      try{ localStorage.setItem('lobsterRoom.mvdbg.open', MVDBG.panelOpen?'1':'0'); }catch{}
      try{ localStorage.setItem('lobsterRoom.mvdbg.overlay', MVDBG.overlayOn?'1':'0'); }catch{}
    }

    function mvNow(){
      if(!MVDBG._t0) MVDBG._t0 = Date.now();
      return ((Date.now()-MVDBG._t0)/1000).toFixed(1)+'s';
    }

    function mvLog(agentId, type, data){
      if(!MVDBG.enabled) return;
      const row = {t: mvNow(), id: agentId, type, data: data||{}};
      MVDBG.log.push(row);
      if(MVDBG.log.length>MVDBG.max) MVDBG.log.splice(0, MVDBG.log.length-MVDBG.max);
      mvRenderPanel();
    }

    function mvActLog(agentId, kind, data){
      // Activity debug piggybacks on the Move Debug panel (more convenient for screenshots).
      mvLog(agentId, 'ACT_'+kind, data||{});
    }

    function mvFmt(row){
      const d=row.data||{};
      const bits=[];

      // Activity events
      if(String(row.type||'').startsWith('ACT_')){
        if(d.buildTag) bits.push('build='+d.buildTag);
        if(d.state) bits.push('state='+d.state);
        if(d.activityState) bits.push('aState='+d.activityState);
        if(d.queueDepth!=null) bits.push('qd='+d.queueDepth);
        if(d.lastEventMs!=null) bits.push('last='+d.lastEventMs);
        if(d.sinceMs!=null) bits.push('since='+d.sinceMs);
        if(d.recentEvents!=null) bits.push('ev='+d.recentEvents);
        if(d.note) bits.push(d.note);
        return `${row.t} ${row.id} ${row.type} ${bits.join(' ')}`.trim();
      }

      // Movement events
      if(d.zone) bits.push('z='+d.zone);
      if(d.zoneChanged!=null) bits.push('zc='+(d.zoneChanged?1:0));
      if(d.targetChanged!=null) bits.push('tc='+(d.targetChanged?1:0));
      if(d.startIdx!=null) bits.push('s='+d.startIdx);
      if(d.endIdx!=null) bits.push('e='+d.endIdx);
      if(d.pathLen!=null) bits.push('len='+d.pathLen);
      if(d.lockLeft!=null) bits.push('lock='+d.lockLeft+'ms');
      if(d.reason) bits.push(d.reason);
      return `${row.t} ${row.id} ${row.type} ${bits.join(' ')}`.trim();
    }

    function mvRenderPanel(){
      const panel = document.getElementById('move-debug');
      if(!panel) return;
      panel.style.display = MVDBG.visible ? 'block' : 'none';
      if(!MVDBG.visible) return;
      const body = document.getElementById('md-body');
      if(body) body.style.display = MVDBG.panelOpen ? '' : 'none';
      const btn = document.getElementById('md-toggle');
      if(btn) btn.textContent = MVDBG.panelOpen ? 'Hide' : 'Show';

      const overlayBtn = document.getElementById('md-overlay');
      if(overlayBtn) overlayBtn.textContent = MVDBG.overlayOn ? 'Overlay: On' : 'Overlay: Off';

      const meta = document.getElementById('md-meta');
      if(meta){
        const room = (typeof MODEL!=='undefined' && MODEL.activeRoomId) ? MODEL.activeRoomId : '';
        const mr = (typeof MODEL!=='undefined' && MODEL.manualReady) ? 'ready' : 'loading';
        const build = (typeof MODEL!=='undefined' && MODEL.buildTag) ? MODEL.buildTag : '';
        const v = MVDBG.lastValidate;
        const vTxt = v ? ` · islands: c=${v.corridorIslands} w=${v.workIslands} t=${v.toolsIslands} l=${v.loungeIslands} m=${v.meetingIslands}` : '';
        meta.textContent = `ui=${UI_VERSION} · build=${build||'—'} · room=${room||'—'} map=${mr} log=${MVDBG.log.length}/${MVDBG.max}${vTxt}`;
      }
      const logEl = document.getElementById('md-log');
      if(logEl){
        const lines = MVDBG.log.slice(-120).map(mvFmt);
        logEl.textContent = lines.join('\n');
        logEl.scrollTop = logEl.scrollHeight;
      }

      const enabled = document.getElementById('md-enabled');
      if(enabled) enabled.checked = !!MVDBG.enabled;
      const freeze = document.getElementById('md-freeze');
      if(freeze) freeze.checked = !!MVDBG.freezeRoam;
    }

    function mvEnsureOverlayCanvas(){
      const room = document.getElementById('room');
      if(!room) return null;
      let c = room.querySelector('canvas.conn-overlay');
      if(!c){
        c = document.createElement('canvas');
        c.className = 'conn-overlay';
        c.style.position='absolute';
        c.style.inset='0';
        c.style.width='100%';
        c.style.height='100%';
        c.style.pointerEvents='none';
        c.style.zIndex='8';
        c.style.display='none';
        room.appendChild(c);
      }
      return c;
    }

    function mvComputeConnectivity(mm){
      // Connected components on WALKABLE cells (4-neighbor).
      if(!mm || !mm.tx || !mm.ty || !Array.isArray(mm.cells)) return null;
      const tx=mm.tx, ty=mm.ty;
      const N=tx*ty;
      const walk = new Uint8Array(N);
      for(let i=0;i<N;i++){
        const t=mm.cells[i];
        if(t && t!=='blocked') walk[i]=1;
      }

      const comp = new Int32Array(N);
      comp.fill(-1);
      const compSize=[];
      let cid=0;
      const q = new Int32Array(N);
      const dirs=[1,0,-1,0, 0,1,0,-1];
      for(let i=0;i<N;i++){
        if(!walk[i] || comp[i]!==-1) continue;
        let qs=0, qe=0;
        q[qe++]=i;
        comp[i]=cid;
        let sz=0;
        while(qs<qe){
          const cur=q[qs++];
          sz++;
          const x=cur%tx, y=(cur/tx)|0;
          for(let k=0;k<dirs.length;k+=2){
            const nx=x+dirs[k], ny=y+dirs[k+1];
            if(nx<0||ny<0||nx>=tx||ny>=ty) continue;
            const ni=ny*tx+nx;
            if(!walk[ni] || comp[ni]!==-1) continue;
            comp[ni]=cid;
            q[qe++]=ni;
          }
        }
        compSize[cid]=sz;
        cid++;
      }

      const zones=['corridor','work','tools','lounge','meeting'];
      const zoneCompCounts={};
      const zoneCompCells={};
      for(const z of zones){ zoneCompCounts[z]=new Map(); zoneCompCells[z]=0; }
      for(let i=0;i<N;i++){
        const z=mm.cells[i];
        if(!z || z==='blocked') continue;
        if(!zoneCompCounts[z]) continue;
        const c=comp[i];
        zoneCompCells[z]++;
        zoneCompCounts[z].set(c, (zoneCompCounts[z].get(c)||0)+1);
      }

      const islands={};
      const dominantComp={};
      for(const z of zones){
        const m=zoneCompCounts[z];
        islands[z]=m.size;
        let bestC=null, bestN=-1;
        for(const [c,n] of m.entries()){
          if(n>bestN){ bestN=n; bestC=c; }
        }
        dominantComp[z]=bestC;
      }

      // Highlight cells that belong to non-dominant components for their zone.
      const hi = new Uint8Array(N);
      for(let i=0;i<N;i++){
        const z=mm.cells[i];
        if(!z || z==='blocked') continue;
        if(!dominantComp.hasOwnProperty(z)) continue;
        const dc = dominantComp[z];
        if(dc!=null && comp[i]!==dc){
          hi[i]=1;
        }
      }

      return {
        tx,ty,comp,compSize,hi,
        corridorIslands:islands.corridor||0,
        workIslands:islands.work||0,
        toolsIslands:islands.tools||0,
        loungeIslands:islands.lounge||0,
        meetingIslands:islands.meeting||0,
      };
    }

    function mvRenderOverlay(){
      const mm = MODEL.manualMap;
      const r = MVDBG.lastValidate;
      const c = mvEnsureOverlayCanvas();
      if(!c) return;
      if(!MVDBG.overlayOn || !MVDBG.enabled || !mm || !r){
        c.style.display='none';
        return;
      }
      const room = document.getElementById('room');
      const rr = room.getBoundingClientRect();
      const W = Math.max(1, Math.floor(rr.width));
      const H = Math.max(1, Math.floor(rr.height));
      c.width=W; c.height=H;
      c.style.display='block';
      const ctx=c.getContext('2d');
      ctx.clearRect(0,0,W,H);

      const tx=r.tx, ty=r.ty;
      const cw=W/tx, ch=H/ty;
      ctx.fillStyle='rgba(255,40,120,0.18)';
      ctx.strokeStyle='rgba(255,40,120,0.55)';
      ctx.lineWidth=1;
      for(let i=0;i<r.hi.length;i++){
        if(!r.hi[i]) continue;
        const x=(i%tx)*cw;
        const y=((i/tx)|0)*ch;
        ctx.fillRect(x,y,cw,ch);
        ctx.strokeRect(x+0.5,y+0.5,Math.max(0,cw-1),Math.max(0,ch-1));
      }

      // Legend note
      ctx.fillStyle='rgba(255,255,255,0.8)';
      ctx.font='12px ui-sans-serif,system-ui';
      ctx.fillText('Unreachable islands (non-dominant components)', 12, H-14);
    }

    function mvValidateNow(){
      const mm = MODEL.manualMap;
      const res = mvComputeConnectivity(mm);
      MVDBG.lastValidate = res;
      if(res){
        mvLog('system','VALIDATE',{
          corridorIslands:res.corridorIslands,
          workIslands:res.workIslands,
          toolsIslands:res.toolsIslands,
          loungeIslands:res.loungeIslands,
          meetingIslands:res.meetingIslands,
        });
      }
      mvRenderPanel();
      mvRenderOverlay();
    }

    function mvInitUI(){
      mvLoadPrefs();
      const panel = document.getElementById('move-debug');
      if(!panel) return;
      panel.style.display = MVDBG.visible ? 'block' : 'none';
      if(!MVDBG.visible){
        try{ mvRenderOverlay(); }catch{}
        return;
      }
      const enabled = document.getElementById('md-enabled');
      const freeze = document.getElementById('md-freeze');
      const clear = document.getElementById('md-clear');
      const download = document.getElementById('md-download');
      const toggle = document.getElementById('md-toggle');
      const validate = document.getElementById('md-validate');
      const overlay = document.getElementById('md-overlay');
      if(enabled) enabled.addEventListener('change', ()=>{ MVDBG.enabled=!!enabled.checked; mvSavePrefs(); mvRenderPanel(); mvRenderOverlay(); });
      if(freeze) freeze.addEventListener('change', ()=>{ MVDBG.freezeRoam=!!freeze.checked; mvSavePrefs(); mvRenderPanel(); });
      if(clear) clear.addEventListener('click', ()=>{ MVDBG.log=[]; mvRenderPanel(); });
      if(download) download.addEventListener('click', ()=>{
        try{
          const now = new Date();
          const pad = (n)=> String(n).padStart(2,'0');
          const ts = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
          const payload = {
            kind: 'lobster-room-move-debug-log',
            exportedAt: now.toISOString(),
            uiVersion: (typeof UI_VERSION!=='undefined') ? UI_VERSION : null,
            buildTag: (typeof MODEL!=='undefined' && MODEL.buildTag) ? MODEL.buildTag : null,
            roomId: (typeof MODEL!=='undefined' && MODEL.activeRoomId) ? MODEL.activeRoomId : null,
            max: MVDBG.max,
            count: MVDBG.log.length,
            log: MVDBG.log,
            lines: MVDBG.log.map(mvFmt),
          };
          const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `lobster-room-move-debug-${ts}.json`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(()=>{ try{ URL.revokeObjectURL(url); }catch{} }, 2000);
        }catch(e){
          console.warn('[lobster-room] download log failed', e);
          try{ alert('Download failed: ' + (e && e.message ? e.message : String(e))); }catch{}
        }
      });
      if(toggle) toggle.addEventListener('click', ()=>{ MVDBG.panelOpen=!MVDBG.panelOpen; mvSavePrefs(); mvRenderPanel(); });
      if(validate) validate.addEventListener('click', ()=>{ mvValidateNow(); });
      if(overlay) overlay.addEventListener('click', ()=>{ MVDBG.overlayOn=!MVDBG.overlayOn; mvSavePrefs(); mvRenderPanel(); mvRenderOverlay(); });

      // Re-render overlay on resize.
      window.addEventListener('resize', ()=>{ try{ mvRenderOverlay(); }catch{} });

      mvRenderPanel();
      // If user had overlay on previously, render after map loads.
      setTimeout(()=>{ try{ mvRenderOverlay(); }catch{} }, 600);
    }
    // ----------------------------------------------------------------

    async function loadLayout(){
      // Prefer server-side when available; fallback to localStorage.
      try{
        const j = await apiGetJson('./api/room-layout');
        if(j) return j;
      }catch{}
      try{
        const raw = localStorage.getItem('lobsterRoom.layout');
        if(raw) return JSON.parse(raw);
      }catch{}
      return null;
    }
    async function saveLayout(layout){
      try{ localStorage.setItem('lobsterRoom.layout', JSON.stringify(layout)); }catch{}
      // best-effort persist to server if endpoint exists
      try{ await fetch('./api/room-layout', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(layout)}); }catch{}
    }

    function tileMetricsFromImage(img, TX, TY, scale=6){
      // Per-tile summary stats used for both tile classification and region heuristics.
      const W=TX*scale, H=TY*scale;
      const c=document.createElement('canvas'); c.width=W; c.height=H;
      const ctx=c.getContext('2d', {willReadFrequently:true});
      ctx.drawImage(img,0,0,W,H);
      const d=ctx.getImageData(0,0,W,H).data;

      const lum=new Float32Array(W*H);
      const sat=new Float32Array(W*H);
      for(let i=0;i<W*H;i++){
        const r=d[i*4]/255, g=d[i*4+1]/255, b=d[i*4+2]/255;
        const max=Math.max(r,g,b), min=Math.min(r,g,b);
        lum[i]=(0.2126*r+0.7152*g+0.0722*b);
        sat[i]=(max===0)?0:((max-min)/max);
      }
      const edge=new Float32Array(W*H);
      for(let y=1;y<H-1;y++) for(let x=1;x<W-1;x++){
        const i=y*W+x;
        const gx=(lum[i+1]-lum[i-1]) + 0.5*(lum[i-W+1]-lum[i-W-1]) + 0.5*(lum[i+W+1]-lum[i+W-1]);
        const gy=(lum[i+W]-lum[i-W]) + 0.5*(lum[i+W+1]-lum[i-W+1]) + 0.5*(lum[i+W-1]-lum[i-W-1]);
        edge[i]=Math.abs(gx)+Math.abs(gy);
      }

      const tw=Math.floor(W/TX), th=Math.floor(H/TY);
      const L=new Float32Array(TX*TY);
      const S=new Float32Array(TX*TY);
      const E=new Float32Array(TX*TY);
      for(let ty=0;ty<TY;ty++) for(let tx=0;tx<TX;tx++){
        let l=0,s=0,e=0;
        for(let y=ty*th;y<(ty+1)*th;y++) for(let x=tx*tw;x<(tx+1)*tw;x++){
          const i=y*W+x;
          l+=lum[i]; s+=sat[i]; e+=edge[i];
        }
        const n=tw*th;
        const k=ty*TX+tx;
        L[k]=l/n; S[k]=s/n; E[k]=e/n;
      }
      return {TX,TY,L,S,E};
    }

    function inferLayoutFromImage(img){
      // Legacy fallback (no tiles): keep previous quadrant heuristic.
      return {
        ok:true,
        version:1,
        generatedAt: Date.now(),
        regions:[
          {id:'work-0',type:'work',bounds:{x1:0.05,y1:0.10,x2:0.52,y2:0.45},weight:1},
          {id:'lounge-0',type:'lounge',bounds:{x1:0.55,y1:0.10,x2:0.95,y2:0.45},weight:1},
          {id:'tools-0',type:'tools',bounds:{x1:0.05,y1:0.55,x2:0.52,y2:0.92},weight:1},
          {id:'meeting-0',type:'meeting',bounds:{x1:0.55,y1:0.55,x2:0.95,y2:0.92},weight:1},
        ],
        stateMap:{ reply:['work'], think:['work'], tool:['tools'], wait:['lounge'], err:['meeting'] },
      };
    }

    function buildWalkableMaskFromTiles(tileModel){
      const {tx,ty,tiles}=tileModel||{};
      if(!tx||!ty||!Array.isArray(tiles)) return null;
      const walk=new Uint8Array(tx*ty);
      for(const t of tiles){
        const k=t.ty*tx+t.tx;
        // walkable: floor only (chairs are treated as non-walkable)
        walk[k]=(t.kind==='floor')?1:0;
      }
      return walk;
    }

    function floodComponents(mask, tx, ty, wantVal){
      // Returns list of components (each = {cells:[], touchesBorder:boolean}).
      const seen=new Uint8Array(tx*ty);
      const comps=[];
      const dirs=[[1,0],[-1,0],[0,1],[0,-1]];
      for(let i=0;i<tx*ty;i++){
        if(seen[i]) continue;
        const v=mask[i];
        if((v?1:0)!==(wantVal?1:0)) continue;
        const q=[i]; seen[i]=1;
        const cells=[];
        let touches=false;
        while(q.length){
          const cur=q.pop();
          cells.push(cur);
          const x=cur%tx, y=Math.floor(cur/tx);
          if(x===0||y===0||x===tx-1||y===ty-1) touches=true;
          for(const [dx,dy] of dirs){
            const nx=x+dx, ny=y+dy;
            if(nx<0||ny<0||nx>=tx||ny>=ty) continue;
            const ni=ny*tx+nx;
            if(seen[ni]) continue;
            if((mask[ni]?1:0)!==(wantVal?1:0)) continue;
            seen[ni]=1;
            q.push(ni);
          }
        }
        comps.push({cells, touchesBorder:touches});
      }
      return comps;
    }

    function cleanWalkableMask(walk, tx, ty){
      // 1) fill small enclosed holes
      const filled=new Uint8Array(walk);
      const holes=floodComponents(filled, tx, ty, 0).filter(c=>!c.touchesBorder);
      const maxHole=Math.max(8, Math.floor(tx*ty*0.006));
      for(const h of holes){
        if(h.cells.length<=maxHole){
          for(const i of h.cells) filled[i]=1;
        }
      }
      // 2) keep only largest walkable component
      const comps=floodComponents(filled, tx, ty, 1);
      if(!comps.length) return filled;
      comps.sort((a,b)=>b.cells.length-a.cells.length);
      const keep=new Uint8Array(tx*ty);
      for(const i of comps[0].cells) keep[i]=1;
      return keep;
    }

    function bfsDistances(mask, tx, ty, sources){
      const dist=new Int32Array(tx*ty);
      dist.fill(-1);
      const qx=[]; const qy=[];
      for(const s of sources){
        dist[s]=0;
        qx.push(s%tx); qy.push(Math.floor(s/tx));
      }
      let qi=0;
      const dirs=[[1,0],[-1,0],[0,1],[0,-1]];
      while(qi<qx.length){
        const x=qx[qi], y=qy[qi];
        const i=y*tx+x;
        const nd=dist[i]+1;
        qi++;
        for(const [dx,dy] of dirs){
          const nx=x+dx, ny=y+dy;
          if(nx<0||ny<0||nx>=tx||ny>=ty) continue;
          const ni=ny*tx+nx;
          if(!mask[ni]) continue;
          if(dist[ni]!==-1) continue;
          dist[ni]=nd;
          qx.push(nx); qy.push(ny);
        }
      }
      return dist;
    }

    function pickKCenters(mask, tx, ty, k){
      const N=tx*ty;
      const non=[];
      for(let i=0;i<N;i++) if(!mask[i]) non.push(i);
      // first seed: farthest-from-nonwalkable (largest clearance). If none, pick first walkable.
      let first=-1;
      if(non.length){
        const d=bfsDistances(mask, tx, ty, non);
        let best=-1, bestD=-1;
        for(let i=0;i<N;i++) if(mask[i] && d[i]>bestD){ bestD=d[i]; best=i; }
        first=best;
      }
      if(first<0){
        for(let i=0;i<N;i++) if(mask[i]){ first=i; break; }
      }
      if(first<0) return [];
      const centers=[first];
      while(centers.length<k){
        const d=bfsDistances(mask, tx, ty, centers);
        let best=-1, bestD=-1;
        for(let i=0;i<N;i++) if(mask[i] && d[i]>bestD){ bestD=d[i]; best=i; }
        if(best<0 || bestD<0) break;
        centers.push(best);
      }
      return centers;
    }

    function multiSourceVoronoi(mask, tx, ty, centers){
      const N=tx*ty;
      const owner=new Int16Array(N);
      const dist=new Int32Array(N);
      owner.fill(-1);
      dist.fill(-1);
      const q=[];
      for(let ci=0;ci<centers.length;ci++){
        const s=centers[ci];
        owner[s]=ci;
        dist[s]=0;
        q.push(s);
      }
      const dirs=[[1,0],[-1,0],[0,1],[0,-1]];
      for(let qi=0;qi<q.length;qi++){
        const cur=q[qi];
        const x=cur%tx, y=Math.floor(cur/tx);
        for(const [dx,dy] of dirs){
          const nx=x+dx, ny=y+dy;
          if(nx<0||ny<0||nx>=tx||ny>=ty) continue;
          const ni=ny*tx+nx;
          if(!mask[ni]) continue;
          if(dist[ni]!==-1) continue;
          dist[ni]=dist[cur]+1;
          owner[ni]=owner[cur];
          q.push(ni);
        }
      }
      return {owner, dist};
    }

    function regionStatsFromCells(regionCells, tileModel, metrics){
      const {tx,ty,tiles}=tileModel;
      const kinds=new Uint8Array(tx*ty); // 0 floor,1 seat,2 obstacle
      for(const t of tiles){
        const i=t.ty*tx+t.tx;
        kinds[i]=(t.kind==='seat')?1:(t.kind==='obstacle')?2:0;
      }
      let seats=0, obstacles=0, floors=0;
      let sofaLike=0, clutter=0, darkFlat=0;
      for(const i of regionCells){
        const k=kinds[i];
        if(k===0) floors++;
        else if(k===1) seats++;
        else obstacles++;

        const L=metrics.L[i], S=metrics.S[i], E=metrics.E[i];
        // sofa-like: low-ish saturation, darker, and relatively smooth
        if(L>0.10 && L<0.45 && S<0.18 && E<0.16) sofaLike++;
        // clutter/bench: edgy tiles
        if(E>0.24) clutter++;
        // dark flat surfaces (desk-like)
        if(L<0.25 && E<0.14) darkFlat++;
      }
      const area=Math.max(1, regionCells.length);
      return {
        area,
        seats,
        obstacles,
        floors,
        chairDensity: seats/area,
        sofaScore: sofaLike/area,
        clutterScore: clutter/area,
        darkFlatScore: darkFlat/area,
      };
    }

    function labelRegionsAuto(regions, tileModel, metrics){
      // Assign {meeting,lounge,tools,work} uniquely.
      const remaining=new Set(regions.map(r=>r.id));
      const byId={};
      for(const r of regions) byId[r.id]=r;

      const pick=(scoreFn)=>{
        let best=null, bestS=-1;
        for(const r of regions){
          if(!remaining.has(r.id)) continue;
          const s=scoreFn(r._stats);
          if(s>bestS){ bestS=s; best=r; }
        }
        if(best) remaining.delete(best.id);
        return best;
      };

      const meeting = pick(st => st.chairDensity);
      if(meeting) meeting.type='meeting';

      const lounge  = pick(st => st.sofaScore);
      if(lounge) lounge.type='lounge';

      const tools   = pick(st => st.clutterScore + 0.35*st.darkFlatScore);
      if(tools) tools.type='tools';

      // Whatever remains: work.
      for(const id of remaining){ byId[id].type='work'; }
      return regions;
    }

    function aStarPath(mask, tx, ty, start, goal){
      // 4-neigh A* with Manhattan heuristic.
      if(start===goal) return [start];
      const N=tx*ty;
      const g=new Int32Array(N); g.fill(1e9);
      const came=new Int32Array(N); came.fill(-1);
      const open=new Set();
      const heap=[]; // [f, node]
      const push=(f,n)=>{ heap.push([f,n]); heap.sort((a,b)=>a[0]-b[0]); };
      const h=(i)=>{
        const x=i%tx, y=(i/tx)|0;
        const gx=goal%tx, gy=(goal/tx)|0;
        return Math.abs(x-gx)+Math.abs(y-gy);
      };
      g[start]=0; push(h(start), start); open.add(start);
      const dirs=[[1,0],[-1,0],[0,1],[0,-1]];
      while(heap.length){
        const cur=heap.shift()[1];
        open.delete(cur);
        if(cur===goal) break;
        const x=cur%tx, y=(cur/tx)|0;
        for(const [dx,dy] of dirs){
          const nx=x+dx, ny=y+dy;
          if(nx<0||ny<0||nx>=tx||ny>=ty) continue;
          const ni=ny*tx+nx;
          if(!mask[ni]) continue;
          const ng=g[cur]+1;
          if(ng<g[ni]){
            g[ni]=ng;
            came[ni]=cur;
            const f=ng+h(ni);
            if(!open.has(ni)){
              open.add(ni);
              push(f, ni);
            }
          }
        }
      }
      if(came[goal]===-1) return [];
      const path=[goal];
      let cur=goal;
      while(cur!==start){
        cur=came[cur];
        if(cur<0) break;
        path.push(cur);
      }
      path.reverse();
      return path;
    }

    function buildCorridors(mask, tx, ty, centers){
      // MST on geodesic distances between region centers; then path per edge.
      const k=centers.length;
      if(k<=1) return [];
      const distMat=[];
      for(let i=0;i<k;i++){
        const d=bfsDistances(mask, tx, ty, [centers[i]]);
        distMat.push(d);
      }
      const inTree=new Array(k).fill(false);
      const minD=new Array(k).fill(1e9);
      const parent=new Array(k).fill(-1);
      inTree[0]=true;
      for(let j=1;j<k;j++){
        const dd=distMat[0][centers[j]];
        minD[j]=(dd<0)?1e9:dd;
        parent[j]=0;
      }
      for(let step=0;step<k-1;step++){
        let v=-1, best=1e9;
        for(let j=0;j<k;j++) if(!inTree[j] && minD[j]<best){ best=minD[j]; v=j; }
        if(v<0) break;
        inTree[v]=true;
        for(let j=0;j<k;j++) if(!inTree[j]){
          const dd=distMat[v][centers[j]];
          const val=(dd<0)?1e9:dd;
          if(val<minD[j]){ minD[j]=val; parent[j]=v; }
        }
      }

      const edges=[];
      for(let i=1;i<k;i++) if(parent[i]>=0 && parent[i]!==i){
        edges.push([i, parent[i]]);
      }
      const corridors=[];
      for(const [a,b] of edges){
        const path=aStarPath(mask, tx, ty, centers[a], centers[b]);
        if(!path.length) continue;
        const pts=path.map(idx=>{
          const x=(idx%tx)+0.5;
          const y=Math.floor(idx/tx)+0.5;
          return {x:x/tx, y:y/ty};
        });
        corridors.push({a, b, pts});
      }
      return corridors;
    }

    function boundsFromCells(cells, tx, ty){
      let minx=1e9,miny=1e9,maxx=-1,maxy=-1;
      for(const i of cells){
        const x=i%tx, y=Math.floor(i/tx);
        minx=Math.min(minx,x); miny=Math.min(miny,y);
        maxx=Math.max(maxx,x); maxy=Math.max(maxy,y);
      }
      if(maxx<minx) return {x1:0,y1:0,x2:1,y2:1};
      return {x1:minx/tx, y1:miny/ty, x2:(maxx+1)/tx, y2:(maxy+1)/ty};
    }

    function inferLayoutFromTilesAndImage(tileModel, img){
      const walk0=buildWalkableMaskFromTiles(tileModel);
      if(!walk0) return inferLayoutFromImage(img);
      const tx=tileModel.tx, ty=tileModel.ty;
      const walk=cleanWalkableMask(walk0, tx, ty);
      const centers=pickKCenters(walk, tx, ty, 4);
      if(centers.length<2) return inferLayoutFromImage(img);

      const {owner}=multiSourceVoronoi(walk, tx, ty, centers);
      const regions=[];
      for(let ci=0;ci<centers.length;ci++) regions.push({id:`r${ci}`, type:'open', centerIdx: centers[ci], cells:[]});
      for(let i=0;i<tx*ty;i++){
        const o=owner[i];
        if(o>=0) regions[o].cells.push(i);
      }
      const metrics=tileMetricsFromImage(img, tx, ty, 6);
      for(const r of regions){
        r.bounds=boundsFromCells(r.cells, tx, ty);
        r._stats=regionStatsFromCells(r.cells, tileModel, metrics);
      }
      labelRegionsAuto(regions, tileModel, metrics);

      const corridors=buildCorridors(walk, tx, ty, centers);
      return {
        ok:true,
        version:2,
        generatedAt: Date.now(),
        tx, ty,
        regions: regions.map(r=>({
          id:r.id,
          type:r.type,
          bounds:r.bounds,
          center:{ x:((r.centerIdx%tx)+0.5)/tx, y:((Math.floor(r.centerIdx/tx))+0.5)/ty },
          cells:r.cells,
          stats:r._stats,
        })),
        corridors,
        stateMap:{ reply:['work'], think:['work'], tool:['tools'], wait:['lounge'], err:['meeting'] },
      };
    }

    function renderCorridors(){
      const room=document.getElementById('room');
      const cv=document.getElementById('corridor-overlay');
      if(!cv) return;
      const show = room.classList.contains('show-regions');
      if(!show || !MODEL.layout || !Array.isArray(MODEL.layout.corridors)){
        const ctx=cv.getContext('2d');
        ctx && ctx.clearRect(0,0,cv.width,cv.height);
        return;
      }
      const rect=room.getBoundingClientRect();
      const w=Math.max(1, Math.floor(rect.width));
      const h=Math.max(1, Math.floor(rect.height));
      cv.width=w; cv.height=h;
      const ctx=cv.getContext('2d');
      ctx.clearRect(0,0,w,h);
      ctx.lineJoin='round';
      ctx.lineCap='round';
      ctx.strokeStyle='rgba(34,211,238,0.55)';
      ctx.lineWidth=Math.max(2, Math.floor(Math.min(w,h)*0.004));
      for(const c of MODEL.layout.corridors){
        if(!c || !Array.isArray(c.pts) || c.pts.length<2) continue;
        ctx.beginPath();
        ctx.moveTo(c.pts[0].x*w, c.pts[0].y*h);
        for(let i=1;i<c.pts.length;i++) ctx.lineTo(c.pts[i].x*w, c.pts[i].y*h);
        ctx.stroke();
      }
    }

    function renderManualZones(){
      const room=document.getElementById('room');
      Array.from(room.querySelectorAll('.r-tag')).forEach(n=>n.remove());
      // Only render when zones debug is enabled.
      if(!room.classList.contains('show-regions')){
        try{
          const cv0=document.getElementById('tile-overlay');
          if(cv0){
            const ctx0=cv0.getContext('2d');
            if(ctx0) ctx0.clearRect(0,0,cv0.width||1,cv0.height||1);
          }
        }catch{}
        return;
      }
      const cv=document.getElementById('tile-overlay');
      if(!cv) return;
      const rect=room.getBoundingClientRect();
      const w=Math.max(1, Math.floor(rect.width));
      const h=Math.max(1, Math.floor(rect.height));
      cv.width=w; cv.height=h;
      const ctx=cv.getContext('2d');
      ctx.clearRect(0,0,w,h);

      const mm = MODEL.manualMap;
      if(!mm || !mm.tx || !mm.ty || !Array.isArray(mm.cells)) return;
      const cw=w/mm.tx, ch=h/mm.ty;
      const colorFor = (t)=>{
        if(t==='work') return 'rgba(99,102,241,0.22)';
        if(t==='tools') return 'rgba(147,51,234,0.20)';
        if(t==='lounge') return 'rgba(250,204,21,0.16)';
        if(t==='meeting') return 'rgba(248,113,113,0.18)';
        if(t==='corridor') return 'rgba(34,211,238,0.18)';
        if(t==='blocked') return 'rgba(0,0,0,0.25)';
        return null;
      };
      // paint cells
      for(let i=0;i<mm.cells.length;i++){
        const t = mm.cells[i];
        const c = colorFor(t);
        if(!c) continue;
        const x=i%mm.tx, y=Math.floor(i/mm.tx);
        ctx.fillStyle=c;
        ctx.fillRect(x*cw, y*ch, cw+0.5, ch+0.5);
      }
      // labels at centroid
      const types=['work','tools','lounge','meeting'];
      for(const t of types){
        let sx=0,sy=0,n=0;
        for(let i=0;i<mm.cells.length;i++) if(mm.cells[i]===t){
          sx += (i%mm.tx)+0.5;
          sy += Math.floor(i/mm.tx)+0.5;
          n++;
        }
        if(n>0){
          const tag=document.createElement('div');
          tag.className='r-tag';
          tag.textContent=t.toUpperCase();
          tag.style.left=((sx/n)/mm.tx*100).toFixed(2)+'%';
          tag.style.top =((sy/n)/mm.ty*100).toFixed(2)+'%';
          room.appendChild(tag);
        }
      }
    }

    function renderRegions(){
      const room=document.getElementById('room');

      // Only render zone overlays/labels when zones debug is enabled.
      // (These big WORK/TOOLS/LOUNGE/MEETING tags are useful for debugging, but they block the room view.)
      if(!room.classList.contains('show-regions')){
        try{ Array.from(room.querySelectorAll('.r-tag')).forEach(n=>n.remove()); }catch{}
        try{ Array.from(room.querySelectorAll('.region')).forEach(n=>n.remove()); }catch{}
        try{
          const cv=document.getElementById('tile-overlay');
          if(cv){
            const ctx=cv.getContext('2d');
            if(ctx) ctx.clearRect(0,0,cv.width||1,cv.height||1);
          }
        }catch{}
        return;
      }

      // Manual map takes precedence for debug display.
      if(MODEL.manualMap){
        renderManualZones();
        return;
      }

      Array.from(room.querySelectorAll('.region')).forEach(n=>n.remove());
      Array.from(room.querySelectorAll('.r-tag')).forEach(n=>n.remove());
      const layout=MODEL.layout;
      if(!layout || !Array.isArray(layout.regions)) return;

      // v2+: render actual region shapes (tile cells) into the tile canvas, not bounding boxes.
      if(layout.version >= 2 && layout.tx && layout.ty){
        const cv=document.getElementById('tile-overlay');
        const rect=room.getBoundingClientRect();
        const w=Math.max(1, Math.floor(rect.width));
        const h=Math.max(1, Math.floor(rect.height));
        cv.width=w; cv.height=h;
        const ctx=cv.getContext('2d');
        ctx.clearRect(0,0,w,h);
        const tx=layout.tx, ty=layout.ty;
        const cw=w/tx, ch=h/ty;
        const colorFor = (t)=>{
          if(t==='work') return 'rgba(99,102,241,0.22)';
          if(t==='tools') return 'rgba(147,51,234,0.20)';
          if(t==='lounge') return 'rgba(250,204,21,0.16)';
          if(t==='meeting') return 'rgba(248,113,113,0.18)';
          return 'rgba(255,255,255,0.06)';
        };
        for(const r of layout.regions){
          if(!r || !Array.isArray(r.cells)) continue;
          ctx.fillStyle = colorFor(r.type);
          for(const idx of r.cells){
            const x=idx%tx, y=Math.floor(idx/tx);
            ctx.fillRect(x*cw, y*ch, cw+0.5, ch+0.5);
          }
          // label at center
          if(r.center){
            const tag=document.createElement('div');
            tag.className='r-tag';
            tag.textContent = (r.type||'open').toUpperCase();
            tag.style.left = (r.center.x*100).toFixed(2)+'%';
            tag.style.top  = (r.center.y*100).toFixed(2)+'%';
            room.appendChild(tag);
          }
        }
      }else{
        // v1 fallback: bounding boxes
        for(const r of layout.regions){
          if(!r || !r.bounds) continue;
          const el=document.createElement('div');
          el.className='region t-'+(r.type||'open');
          el.style.left=(r.bounds.x1*100).toFixed(2)+'%';
          el.style.top=(r.bounds.y1*100).toFixed(2)+'%';
          el.style.width=((r.bounds.x2-r.bounds.x1)*100).toFixed(2)+'%';
          el.style.height=((r.bounds.y2-r.bounds.y1)*100).toFixed(2)+'%';
          el.innerHTML='<div class="tag">'+(r.type||'open')+'</div>';
          room.appendChild(el);
        }
      }
      renderCorridors();
    }

    function inferTilesFromImage(img){
      // Produces a coarse grid of tiles with 3 classes: floor / obstacle / seat.
      // This is a pragmatic heuristic for your current room image (wood floor + yellow chairs).
      const TX=64, TY=40;
      const W=TX*6, H=TY*6;
      const c=document.createElement('canvas'); c.width=W; c.height=H;
      const ctx=c.getContext('2d', {willReadFrequently:true});
      ctx.drawImage(img,0,0,W,H);
      const d=ctx.getImageData(0,0,W,H).data;

      const lum=new Float32Array(W*H);
      const sat=new Float32Array(W*H);
      for(let i=0;i<W*H;i++){
        const r=d[i*4]/255, g=d[i*4+1]/255, b=d[i*4+2]/255;
        const max=Math.max(r,g,b), min=Math.min(r,g,b);
        lum[i]=(0.2126*r+0.7152*g+0.0722*b);
        sat[i]=(max===0)?0:((max-min)/max);
      }
      // edge magnitude
      const edge=new Float32Array(W*H);
      for(let y=1;y<H-1;y++) for(let x=1;x<W-1;x++){
        const i=y*W+x;
        const gx=(lum[i+1]-lum[i-1]) + 0.5*(lum[i-W+1]-lum[i-W-1]) + 0.5*(lum[i+W+1]-lum[i+W-1]);
        const gy=(lum[i+W]-lum[i-W]) + 0.5*(lum[i+W+1]-lum[i-W+1]) + 0.5*(lum[i+W-1]-lum[i-W-1]);
        edge[i]=Math.abs(gx)+Math.abs(gy);
      }

      const tw=Math.floor(W/TX), th=Math.floor(H/TY);
      const tiles=[];
      for(let ty=0;ty<TY;ty++){
        for(let tx=0;tx<TX;tx++){
          let L=0,S=0,E=0;
          for(let y=ty*th;y<(ty+1)*th;y++) for(let x=tx*tw;x<(tx+1)*tw;x++){
            const i=y*W+x;
            L+=lum[i]; S+=sat[i]; E+=edge[i];
          }
          const n=tw*th;
          L/=n; S/=n; E/=n;
          // Heuristics:
          // - seats: higher saturation (yellow chairs) and mid brightness
          // - obstacles: high edge density (desk clutter) or very dark
          // - floor: the rest
          let kind='floor';
          if(S>0.32 && L>0.28 && L<0.85) kind='seat';
          if(E>0.18 || L<0.16) kind='obstacle';
          // Prefer seat over obstacle unless it's extremely edgy
          if(kind==='obstacle' && S>0.36 && E<0.26) kind='seat';
          tiles.push({tx,ty,kind});
        }
      }
      return { ok:true, version:1, tx:TX, ty:TY, tiles, generatedAt: Date.now() };
    }

    function renderTileOverlay(){
      const room=document.getElementById('room');
      const cv=document.getElementById('tile-overlay');
      if(!cv) return;
      const show = room.classList.contains('show-tiles');
      if(!show || !MODEL.tiles){
        const ctx=cv.getContext('2d');
        ctx && ctx.clearRect(0,0,cv.width,cv.height);
        return;
      }
      const rect=room.getBoundingClientRect();
      const w=Math.max(1, Math.floor(rect.width));
      const h=Math.max(1, Math.floor(rect.height));
      cv.width=w; cv.height=h;
      const ctx=cv.getContext('2d');
      const {tx,ty,tiles}=MODEL.tiles;
      const cw=w/tx, ch=h/ty;
      ctx.clearRect(0,0,w,h);
      for(const t of tiles){
        if(t.kind==='floor') ctx.fillStyle='rgba(34,197,94,0.14)';      // green
        else if(t.kind==='seat') ctx.fillStyle='rgba(34,211,238,0.28)'; // cyan
        else ctx.fillStyle='rgba(248,113,113,0.16)';                    // red
        ctx.fillRect(t.tx*cw, t.ty*ch, cw+0.5, ch+0.5);
      }
    }

    async function ensureTiles(force){
      if(!document.getElementById('room').classList.contains('has-bg')) return;
      if(!force && MODEL.tiles) return;
      const img=document.getElementById('room-bg');
      if(!img || !img.complete) return;
      MODEL.tiles = inferTilesFromImage(img);
      try{ localStorage.setItem('lobsterRoom.tiles', JSON.stringify(MODEL.tiles)); }catch{}
      renderTileOverlay();
    }

    async function ensureLayout(force){
      if(!document.getElementById('room').classList.contains('has-bg')) return;
      if(!force){
        const existing=await loadLayout();
        // If we already inferred v2 (regions + corridors + cells), prefer it.
        if(existing && existing.version>=2 && Array.isArray(existing.regions)){
          MODEL.layout=existing;
          renderRegions();
          return;
        }
      }
      const img=document.getElementById('room-bg');
      if(!img || !img.complete) return;
      await ensureTiles(false);
      const layout = (MODEL.tiles && MODEL.tiles.tiles)
        ? inferLayoutFromTilesAndImage(MODEL.tiles, img)
        : inferLayoutFromImage(img);
      MODEL.layout=layout;
      renderRegions();
      await saveLayout(layout);
    }

    // Spawn areas are in room-percent coordinates (screen space).
    // Tuned to match the top-down rugs.
    const ZONES = {
      work:   {x1:14, y1:20, x2:46, y2:46, label:'Work'},
      tools:  {x1:54, y1:20, x2:86, y2:46, label:'Tools'},
      lounge: {x1:14, y1:52, x2:46, y2:82, label:'Lounge'},
      meeting:{x1:54, y1:52, x2:86, y2:82, label:'Meeting'},
    };

    function stateMeta(key){
      return STATES.find(s=>s.key===key) || STATES[3];
    }

    // --- UI state min-dwell / playback ---
    // In practice, backend state can change faster than the 1s polling tick. To avoid states being
    // "skipped" visually, we play back a short sequence with a minimum dwell time per non-idle state.
    const STATE_MIN_DWELL_MS = 1000;
    function normUiState(s){
      const v = String(s||'').toLowerCase();
      if(v==='thinking') return 'think';
      if(v==='replying') return 'reply';
      if(v==='building') return 'build';
      return v;
    }
    function isIdleState(s){
      return s==='wait' || s==='idle' || s==='';
    }
    function playbackUiState(wrap, rawState){
      const now = Date.now();
      const raw = normUiState(rawState);
      if(!wrap._stQ) wrap._stQ = [];
      if(!wrap._stCur){
        wrap._stCur = raw;
        wrap._stUntil = isIdleState(raw) ? 0 : (now + STATE_MIN_DWELL_MS);
        return wrap._stCur;
      }

      // Advance queued states when dwell completes.
      if(wrap._stQ.length && now >= (wrap._stUntil||0)){
        const nxt = wrap._stQ.shift();
        if(nxt!=null){
          wrap._stCur = nxt;
          wrap._stUntil = isIdleState(nxt) ? 0 : (now + STATE_MIN_DWELL_MS);
        }
      }

      const cur = wrap._stCur;
      if(raw && raw !== cur){
        const last = wrap._stQ.length ? wrap._stQ[wrap._stQ.length-1] : cur;
        // Avoid unbounded growth; keep only a small window.
        if(raw !== last){
          // If we already have pending states, do not bother enqueuing idle/wait.
          if(!(isIdleState(raw) && wrap._stQ.length)){
            wrap._stQ.push(raw);
            if(wrap._stQ.length > 6) wrap._stQ.splice(0, wrap._stQ.length-6);
          }
        }
      }

      // If current is idle and we have queued non-idle states, switch immediately.
      if(isIdleState(wrap._stCur) && wrap._stQ.length){
        const nxt = wrap._stQ.shift();
        if(nxt!=null){
          wrap._stCur = nxt;
          wrap._stUntil = isIdleState(nxt) ? 0 : (now + STATE_MIN_DWELL_MS);
        }
      }

      return wrap._stCur;
    }

    function renderLegend(){
      const el = document.getElementById('legend');
      el.innerHTML = '';
      for(const s of STATES){
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.innerHTML = `<b>${s.label.split(' ')[0]}</b> ${s.label.split(' ').slice(1).join(' ')}`;
        el.appendChild(chip);
      }
    }

    function hash01(str){
      // tiny deterministic hash -> [0,1)
      let h = 2166136261;
      for(let i=0;i<str.length;i++){
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      // unsigned
      h >>>= 0;
      return (h % 1000000) / 1000000;
    }

    // Zone selection can be noisy because backend state may flicker (e.g., tool → idle → tool)
    // during short gaps. We debounce zone transitions client-side to avoid visual ping-pong.
    function zoneForAgent(agent){
      const id = String(agent && agent.id || '');
      const s = String(agent && agent.state || '').toLowerCase();

      let proposed = 'lounge';
      if(s === 'err' || s === 'error' || s === 'failed') proposed = 'meeting';
      else if(s === 'tool' || s === 'tools') proposed = 'tools';
      else if(s === 'reply' || s === 'replying' || s === 'respond' || s === 'responding') proposed = 'work';
      else if(s === 'think' || s === 'thinking' || s === 'reason' || s === 'reasoning') proposed = 'work';
      else if(s === 'build' || s === 'building') proposed = 'work';
      else if(s === 'wait' || s === 'idle' || s === 'paused') proposed = 'lounge';

      const now = Date.now();
      MODEL._zoneMem = MODEL._zoneMem || {};
      const mem = MODEL._zoneMem[id] || (MODEL._zoneMem[id] = {
        zone: proposed,
        lastNonIdleZone: proposed,
        lastNonIdleAt: now,
        pending: null,
        pendingAt: 0,
      });

      // Track last non-idle zone so brief idle gaps don't yank the agent to Lounge.
      const isIdle = (proposed === 'lounge');
      if(!isIdle){
        mem.lastNonIdleZone = proposed;
        mem.lastNonIdleAt = now;
      }

      // Idle grace: if we just were active recently, keep the last non-idle zone.
      const idleGraceMs = 15000;
      if(isIdle && mem.lastNonIdleZone && (now - (mem.lastNonIdleAt||0)) < idleGraceMs){
        proposed = mem.lastNonIdleZone;
      }

      // Debounce any zone change.
      const debounceMs = 2500;
      if(proposed !== mem.zone){
        if(mem.pending !== proposed){
          mem.pending = proposed;
          mem.pendingAt = now;
          return mem.zone;
        }
        if((now - (mem.pendingAt||0)) < debounceMs){
          return mem.zone;
        }
        // Commit.
        mem.zone = proposed;
        mem.pending = null;
        mem.pendingAt = 0;
        return mem.zone;
      }

      // Stable.
      mem.pending = null;
      mem.pendingAt = 0;
      return mem.zone;
    }

    function regionForAgent(agent){
      const layout = MODEL.layout;
      if(!layout || !Array.isArray(layout.regions) || !layout.stateMap) return null;
      const prefs = layout.stateMap[agent.state] || layout.stateMap.wait || [];
      for(const t of prefs){
        const r = layout.regions.find(x => x && x.type === t);
        if(r) return r;
      }
      return layout.regions[0] || null;
    }

    function layoutAgentsByZone(agents){
      // MVP manual map placement (painted by user)
      const mm = MODEL.manualMap;
      if(mm && mm.tx && mm.ty && Array.isArray(mm.cells)){
        const tx = mm.tx, ty = mm.ty;
        const cellsByType = {work:[], tools:[], lounge:[], meeting:[], corridor:[]};
        const anyWalkable = [];
        for(let i=0;i<mm.cells.length;i++){
          const t = mm.cells[i];
          if(t && cellsByType[t]) cellsByType[t].push(i);
          if(t && t !== 'blocked') anyWalkable.push(i);
        }
        const listAll = [...agents].sort((aa, bb) => (aa.id || '').localeCompare(bb.id || ''));
        const placed = [];
        // Prevent overlap: ensure each agent gets a distinct cell when possible.
        // (We include zone in the key so agents in different zones can reuse the same index.)
        const usedCells = new Set(); // key: "<zone>:<idx>"

        for(const a of listAll){
          const z = zoneForAgent(a);
          const pool = (cellsByType[z] && cellsByType[z].length) ? cellsByType[z]
            : (cellsByType.corridor && cellsByType.corridor.length) ? cellsByType.corridor
            : (anyWalkable && anyWalkable.length) ? anyWalkable
            : null;

          if(pool && pool.length){
            // Candidate roaming target (will be locked per-agent while walking).
            const bucket = Math.floor(Date.now() / 10000);
            // Debug: optionally freeze roaming so we can isolate movement issues.
            const roamBucket = (MVDBG && MVDBG.freezeRoam) ? 0 : bucket;
            const k0 = Math.floor(hash01(`${a.id}|${z}|${roamBucket}`) * pool.length) % pool.length;

            const lockKey = `lobsterRoom.lock.${a.id}`;
            let locked = null;
            try{ locked = JSON.parse(localStorage.getItem(lockKey) || 'null'); }catch{}
            const now = Date.now();

            // Try to keep the lock *only if* it doesn't collide with someone else.
            let idxPick = null;
            if(locked && locked.idx!=null && locked.zone===z && locked.untilMs>now && locked.idx>=0 && locked.idx<mm.cells.length && mm.cells[locked.idx]===z){
              const lk = `${z}:${locked.idx}`;
              if(!usedCells.has(lk)) idxPick = locked.idx;
            }

            // Otherwise pick the first free cell via linear probing from a stable start.
            if(idxPick==null){
              for(let step=0; step<pool.length; step++){
                const idxTry = pool[(k0 + step) % pool.length];
                const key = `${z}:${idxTry}`;
                if(!usedCells.has(key)) { idxPick = idxTry; break; }
              }
            }

            // Absolute fallback (no free cells): allow collision, but still place deterministically.
            if(idxPick==null) idxPick = pool[k0];

            usedCells.add(`${z}:${idxPick}`);

            // IMPORTANT: when using manualMap, keep position at exact cell centers.
            // Sub-cell jitter can visually drift the sprite into nearby blocked/obstacle pixels
            // and can also cause startIdx estimation to snap to an adjacent cell.
            const x = (idxPick % tx) + 0.5;
            const y = Math.floor(idxPick / tx) + 0.5;
            const px = (x / tx) * 100;
            const py = (y / ty) * 100;
            placed.push({...a, _zone: z, _px: px, _py: py, _cellIdx: idxPick, _gridTx: tx, _gridTy: ty});
            continue;
          }
          // If manualMap exists but we somehow have no cells at all, keep legacy fallback.
          placed.push({...a, _zone: z, _px: (ZONES[z]?.x1||10), _py: (ZONES[z]?.y1||10)});
        }
        return placed;
      }

      // Prefer inferred layout when available (state -> region type).
      const layout = MODEL.layout;
      if(layout && Array.isArray(layout.regions) && layout.regions.length && layout.stateMap){
        const byType = {};
        const listAll = [...agents].sort((aa, bb) => (aa.id || '').localeCompare(bb.id || ''));
        for(const a of listAll){
          const r = regionForAgent(a);
          const t = (r && r.type) ? r.type : 'open';
          (byType[t] || (byType[t]=[])).push(a);
        }

        const placed = [];
        for(const [type, list] of Object.entries(byType)){
          const region = layout.regions.find(x=>x && x.type===type) || layout.regions[0];
          if(!region || !region.bounds) continue;
          const b = {
            x1: region.bounds.x1*100,
            y1: region.bounds.y1*100,
            x2: region.bounds.x2*100,
            y2: region.bounds.y2*100,
          };

          const w = (b.x2 - b.x1);
          const h = (b.y2 - b.y1);
          const cols = Math.max(1, Math.min(4, Math.floor(w / 8)));
          const dx = w / (cols + 1);
          const dy = Math.max(6, h / (Math.ceil(list.length / cols) + 1));

          for(let i=0;i<list.length;i++){
            const a = list[i];
            const col = i % cols;
            const row = Math.floor(i / cols);
            const r1 = hash01(`${a.id}|${type}|x`);
            const r2 = hash01(`${a.id}|${type}|y`);
            const jx = (r1 - 0.5) * 3.0;
            const jy = (r2 - 0.5) * 2.0;
            const px = b.x1 + dx * (col + 1) + jx;
            const py = b.y1 + dy * (row + 1) + jy;
            placed.push({...a, _zone: type, _px: px, _py: py});
          }
        }
        return placed;
      }

      // Fallback: legacy 4 zones.
      const byZone = {work:[], tools:[], lounge:[], meeting:[]};
      for(const a of agents){
        const z = zoneForAgent(a);
        (byZone[z] || (byZone[z]=[])).push(a);
      }

      const placed = [];
      for(const [zone, list] of Object.entries(byZone)){
        const b = ZONES[zone];
        if(!b) continue;

        // stable order so agents don't jump around between polls
        list.sort((aa, bb) => (aa.id || '').localeCompare(bb.id || ''));

        const w = (b.x2 - b.x1);
        const h = (b.y2 - b.y1);
        const cols = Math.max(1, Math.min(4, Math.floor(w / 8))); // ~8% per column
        const dx = w / (cols + 1);
        const dy = Math.max(6, h / (Math.ceil(list.length / cols) + 1));

        for(let i=0;i<list.length;i++){
          const a = list[i];
          const col = i % cols;
          const row = Math.floor(i / cols);

          // jitter: small, deterministic (per agent+zone) so it feels organic but stable.
          const r1 = hash01(`${a.id}|${zone}|x`);
          const r2 = hash01(`${a.id}|${zone}|y`);
          const jx = (r1 - 0.5) * 3.0; // +/-1.5%
          const jy = (r2 - 0.5) * 2.0; // +/-1%

          const px = b.x1 + dx * (col + 1) + jx;
          const py = b.y1 + dy * (row + 1) + jy;

          placed.push({...a, _zone: zone, _px: px, _py: py});
        }
      }
      return placed;
    }

    function manualWalkableInfo(){
      const mm = MODEL.manualMap;
      if(!mm || !mm.tx || !mm.ty || !Array.isArray(mm.cells)) return null;
      const tx=mm.tx, ty=mm.ty;
      const walk = new Uint8Array(tx*ty);
      const isCorr = new Uint8Array(tx*ty);

      // 1) Base mask: user-painted zones/corridor.
      for(let i=0;i<mm.cells.length;i++){
        const t = mm.cells[i];
        if(t==='blocked' || t==null) continue;
        if(['work','tools','lounge','meeting','corridor'].includes(t)) walk[i]=1;
        if(t==='corridor') isCorr[i]=1;
      }

      // 2) Safety: if we have inferred tiles (seats/obstacles), intersect them so we never
      //    walk through desks/tables/chairs even if the user accidentally painted them.
      //    (Only when tile grid matches manual map resolution.)
      try{
        const tm = MODEL.tiles;
        if(tm && tm.tx===tx && tm.ty===ty && Array.isArray(tm.tiles)){
          for(const t of tm.tiles){
            const i = (t.ty|0)*tx + (t.tx|0);
            if(i<0 || i>=walk.length) continue;
            if(t.kind === 'obstacle' || t.kind === 'seat') walk[i]=0;
          }
        }
      }catch{}

      return {tx,ty,walk,isCorr};
    }

    function bfsPrev(tx, ty, walk, startIdx){
      const prev = new Int32Array(tx*ty);
      prev.fill(-1);
      const q = new Int32Array(tx*ty);
      let qs=0, qe=0;
      q[qe++] = startIdx;
      prev[startIdx] = startIdx;
      const dirs = [1,0,-1,0, 0,1,0,-1];
      while(qs<qe){
        const cur = q[qs++];
        const x = cur % tx;
        const y = (cur/tx)|0;
        for(let k=0;k<dirs.length;k+=2){
          const nx=x+dirs[k], ny=y+dirs[k+1];
          if(nx<0||ny<0||nx>=tx||ny>=ty) continue;
          const ni = ny*tx+nx;
          if(!walk[ni]) continue;
          if(prev[ni]!==-1) continue;
          prev[ni]=cur;
          q[qe++]=ni;
        }
      }
      return prev;
    }

    function pathFromPrev(prev, startIdx, endIdx){
      if(endIdx<0) return [];
      if(prev[endIdx]===-1) return [];
      const path=[];
      let cur=endIdx;
      while(cur!==startIdx){
        path.push(cur);
        const p=prev[cur];
        if(p===cur || p===-1) break;
        cur=p;
      }
      path.push(startIdx);
      path.reverse();
      return path;
    }

    function nearestCorridor(info, startIdx){
      // True nearest corridor by BFS frontier (not "first index in array").
      const {tx,ty,walk,isCorr}=info;
      if(startIdx==null || startIdx<0 || startIdx>=tx*ty) return null;
      if(!walk[startIdx]) return null;
      if(isCorr[startIdx]) return startIdx;

      const seen = new Uint8Array(tx*ty);
      const q = new Int32Array(tx*ty);
      let qs=0, qe=0;
      q[qe++]=startIdx;
      seen[startIdx]=1;
      const dirs = [1,0,-1,0, 0,1,0,-1];
      while(qs<qe){
        const cur=q[qs++];
        const x=cur%tx, y=(cur/tx)|0;
        for(let k=0;k<dirs.length;k+=2){
          const nx=x+dirs[k], ny=y+dirs[k+1];
          if(nx<0||ny<0||nx>=tx||ny>=ty) continue;
          const ni=ny*tx+nx;
          if(seen[ni]) continue;
          if(!walk[ni]) continue;
          if(isCorr[ni]) return ni;
          seen[ni]=1;
          q[qe++]=ni;
        }
      }
      return null;
    }

    function nearestWalkable(info, startIdx){
      const {tx,ty,walk}=info;
      if(startIdx>=0 && startIdx<walk.length && walk[startIdx]) return startIdx;
      // BFS outward until we hit any walkable cell.
      const prev = new Int32Array(tx*ty);
      prev.fill(-1);
      const q = new Int32Array(tx*ty);
      let qs=0, qe=0;
      if(startIdx<0 || startIdx>=tx*ty) return null;
      q[qe++]=startIdx;
      prev[startIdx]=startIdx;
      const dirs=[1,0,-1,0, 0,1,0,-1];
      while(qs<qe){
        const cur=q[qs++];
        if(walk[cur]) return cur;
        const x=cur%tx, y=(cur/tx)|0;
        for(let k=0;k<dirs.length;k+=2){
          const nx=x+dirs[k], ny=y+dirs[k+1];
          if(nx<0||ny<0||nx>=tx||ny>=ty) continue;
          const ni=ny*tx+nx;
          if(prev[ni]!==-1) continue;
          prev[ni]=cur;
          q[qe++]=ni;
        }
      }
      return null;
    }

    function manualPath(info, startIdx, endIdx){
      const {tx,ty,walk,isCorr}=info;
      if(startIdx===endIdx) return [startIdx];
      if(!walk[startIdx] || !walk[endIdx]) return [];

      // If no corridor defined, just direct shortest path on walkable.
      const anyCorr = isCorr.some(v=>v===1);
      const direct = ()=>{
        const prev=bfsPrev(tx,ty,walk,startIdx);
        return pathFromPrev(prev,startIdx,endIdx);
      };
      if(!anyCorr) return direct();

      const sCorr = nearestCorridor(info,startIdx);
      const eCorr = nearestCorridor(info,endIdx);
      if(sCorr==null || eCorr==null) return direct();

      const prev1=bfsPrev(tx,ty,walk,startIdx);
      const p1=pathFromPrev(prev1,startIdx,sCorr);
      const prev2=bfsPrev(tx,ty,walk,sCorr);
      const p2=pathFromPrev(prev2,sCorr,eCorr);
      const prev3=bfsPrev(tx,ty,walk,eCorr);
      const p3=pathFromPrev(prev3,eCorr,endIdx);

      // If corridor stitching fails for any segment, fall back to direct path.
      if(!p1.length || !p2.length || !p3.length) return direct();

      // merge
      const out=[];
      for(const p of [p1,p2.slice(1),p3.slice(1)]) for(const v of p){
        if(out.length===0 || out[out.length-1]!==v) out.push(v);
      }
      return out;
    }

    function zoneOnlyPath(mm, zone, startIdx, endIdx){
      if(!mm || !mm.tx || !mm.ty || !Array.isArray(mm.cells)) return [];
      const tx=mm.tx, ty=mm.ty;
      if(startIdx<0||endIdx<0||startIdx>=tx*ty||endIdx>=tx*ty) return [];
      const walk = new Uint8Array(tx*ty);
      for(let i=0;i<mm.cells.length;i++){
        if(mm.cells[i]===zone) walk[i]=1;
      }
      if(!walk[startIdx] || !walk[endIdx]) return [];
      const prev=bfsPrev(tx,ty,walk,startIdx);
      return pathFromPrev(prev,startIdx,endIdx);
    }

    function nearestReachableZoneCell(info, mm, startIdx, zone, avoidIdx){
      if(!info || !mm) return null;
      const {tx,ty,walk}=info;
      if(startIdx==null || startIdx<0 || startIdx>=tx*ty) return null;
      if(!walk[startIdx]) return null;
      const seen = new Uint8Array(tx*ty);
      const q = new Int32Array(tx*ty);
      let qs=0, qe=0;
      q[qe++]=startIdx;
      seen[startIdx]=1;
      const dirs=[1,0,-1,0, 0,1,0,-1];
      while(qs<qe){
        const cur=q[qs++];
        if(cur!==avoidIdx && mm.cells[cur]===zone) return cur;
        const x=cur%tx, y=(cur/tx)|0;
        for(let k=0;k<dirs.length;k+=2){
          const nx=x+dirs[k], ny=y+dirs[k+1];
          if(nx<0||ny<0||nx>=tx||ny>=ty) continue;
          const ni=ny*tx+nx;
          if(seen[ni]) continue;
          if(!walk[ni]) continue;
          seen[ni]=1;
          q[qe++]=ni;
        }
      }
      return null;
    }

    function startNodePath(wrap, ptsPercent, opts){
      // Cancel old
      if(wrap._pathTimer) clearTimeout(wrap._pathTimer);
      wrap._pathTimer = null;
      wrap._walking = false;
      wrap._lockedUntilMs = 0;
      if(!ptsPercent || ptsPercent.length===0) return;

      const now = Date.now();
      const lockMs = (opts && opts.lockMs) ? opts.lockMs : 10000;
      wrap._walking = true;
      wrap._lockedUntilMs = now + lockMs;
      wrap._boost = false;

      // Debug
      try{
        wrap._mv = wrap._mv || {};
        wrap._mv.mode = 'grid';
        wrap._mv.lastStepAt = Date.now();
        wrap._mv.pathLen = ptsPercent.length;
        wrap._mv.step = 0;
      }catch{}

      let i=0;
      const step = ()=>{
        if(i>=ptsPercent.length){
          wrap._walking = false;
          wrap._lockedUntilMs = 0;
          wrap._boost = false;
          try{ mvLog(wrap.dataset.id || '?', 'ARRIVE', {pathLen: ptsPercent.length}); }catch{}
          return;
        }
        const [px,py] = ptsPercent[i++];
        try{
          wrap._mv = wrap._mv || {};
          wrap._mv.lastStepAt = Date.now();
          wrap._mv.step = i;
        }catch{}
        const prevPx = parseFloat(wrap.dataset.px || String(px));
        const prevPy = parseFloat(wrap.dataset.py || String(py));
        const rr = document.getElementById('room').getBoundingClientRect();
        const w = Math.max(1, rr.width);
        const h = Math.max(1, rr.height);
        const dx = (px - prevPx) / 100 * w;
        const dy = (py - prevPy) / 100 * h;
        const dist = Math.hypot(dx, dy);
        // Speed model:
        // - Per-step duration still considers pixel distance (so big visual jumps are slower than tiny ones)
        // - BUT long paths should overall move faster (so cross-zone travel doesn't take forever).
        const pathN = Math.max(1, ptsPercent.length);
        const longFastDur = 100; // ms per step for long paths (Edward request)
        const shortDur = 260;    // ms per step for short paths
        const f = Math.max(0, Math.min(1, (pathN - 8) / 30)); // 0..1, ramps up with path length
        const baseDur = shortDur + (longFastDur - shortDur) * f;

        // Distance-based modifier (keeps motion feeling natural on different screen sizes)
        const dNorm = Math.max(0, Math.min(1, dist / 520));
        const distMul = 0.80 + 0.60 * dNorm; // 0.8x..1.4x
        let dur = Math.round(Math.max(70, Math.min(1100, baseDur * distMul)));

        // Boost mode: when runtime state changes mid-walk, finish the current path quickly.
        if(wrap._boost){
          dur = 20;
        }

        wrap.style.setProperty('--moveDur', dur + 'ms');
        wrap.dataset.px = String(px);
        wrap.dataset.py = String(py);
        wrap.style.left = px + '%';
        wrap.style.top  = py + '%';
        wrap._pathTimer = setTimeout(step, Math.max(20, dur));
      };
      step();
    }

    function renderAgents(){
      const room = document.getElementById('room');
      if(!MODEL.nodeById) MODEL.nodeById = {};

      const placed = layoutAgentsByZone(MODEL.agents);
      const nextIds = new Set(placed.map(a=>a.id));

      // Remove nodes that disappeared
      for(const [id, node] of Object.entries(MODEL.nodeById)){
        if(!nextIds.has(id)){
          node.style.opacity = '0';
          setTimeout(()=>{ try{ node.remove(); }catch{} }, 250);
          delete MODEL.nodeById[id];
        }
      }

      const rr = room.getBoundingClientRect();
      const w = Math.max(1, rr.width);
      const h = Math.max(1, rr.height);

      for(const a of placed){
        const shortId = String(a.id||'').replace(/^resident@/,'');
        let wrap = MODEL.nodeById[a.id];
        const dispState = wrap ? playbackUiState(wrap, a.state) : normUiState(a.state);
        const meta = stateMeta(dispState);
        const zoneLabel = (ZONES[a._zone] && ZONES[a._zone].label) ? ZONES[a._zone].label : (a._zone || '');

        if(!wrap){
          wrap = document.createElement('div');
          wrap.className = 'lobster';
          // state playback init
          try{ wrap._stCur = normUiState(a.state); wrap._stQ = []; wrap._stUntil = isIdleState(wrap._stCur) ? 0 : (Date.now()+STATE_MIN_DWELL_MS); }catch{}
          wrap.style.opacity = '0';
          wrap.dataset.id = String(a.id||'');
          wrap.dataset.px = String(a._px);
          wrap.dataset.py = String(a._py);
          wrap.style.left = a._px + '%';
          wrap.style.top  = a._py + '%';
          wrap.innerHTML = `
            <div class="bubble ${meta.cls}"><span class="b-dot"></span><span class="b-text">${meta.label}</span></div>
            <div class="icon">🦞</div>
            <div class="name" title="${a.id}"><span class="n-text">${a.name}</span> <span class="n-zone" style="color:var(--dim);font-weight:600">(${zoneLabel})</span></div>
            <div class="detail"></div>
            <div class="hud"></div>
          `;
          room.appendChild(wrap);
          // Animation state (default idle wiggle)
          wrap.classList.add('wiggle-idle');
          wrap.classList.remove('wiggle-move');
          // fade in
          requestAnimationFrame(()=>{ wrap.style.opacity = '1'; });
          MODEL.nodeById[a.id] = wrap;
          continue;
        }

        // Update text/state
        const bubble = wrap.querySelector('.bubble');
        if(bubble){
          bubble.className = 'bubble ' + meta.cls;
          const bt = bubble.querySelector('.b-text');
          if(bt) bt.textContent = meta.label;
        }
        const nt = wrap.querySelector('.n-text');
        if(nt) nt.textContent = a.name;

        // If runtime state changes while walking, boost movement to finish quickly.
        try{
          const prevState = wrap.dataset.state || '';
          const nextState = String(a.state||'');
          const stateChanged = (prevState && nextState && prevState !== nextState);
          wrap.dataset.state = nextState;
          if(stateChanged && wrap._walking){
            wrap._boost = true;
            try{ mvLog(a.id,'BOOST_ON_STATE',{zone:a._zone, prevState, nextState}); }catch{}
          }
        }catch{}
        const nz = wrap.querySelector('.n-zone');
        if(nz) nz.textContent = '(' + zoneLabel + ')';

        // Movement: if manualMap has corridor, route across corridor when zone changes.
        // Note: when a node is first created, wrap.dataset.zone is empty; treat that as a change.

        // Wiggle animation mode: move-wiggle while walking, otherwise idle-wiggle.
        try{
          const moving = !!wrap._walking;
          wrap.classList.toggle('wiggle-move', moving);
          wrap.classList.toggle('wiggle-idle', !moving);
        }catch{}
        const hadPrevZone = !!wrap.dataset.zone;
        const prevZone = wrap.dataset.zone || a._zone;
        // On first paint, treat it as "no zone change"; otherwise initial load will route via corridor and look jittery.
        const zoneChanged = hadPrevZone ? (prevZone !== a._zone) : false;
        const prevTarget = wrap.dataset.targetIdx ? parseInt(wrap.dataset.targetIdx, 10) : null;
        const targetChanged = (typeof a._cellIdx === 'number') && (prevTarget == null || prevTarget !== a._cellIdx);
        wrap.dataset.zone = a._zone;
        if(typeof a._cellIdx === 'number') wrap.dataset.targetIdx = String(a._cellIdx);

        const info = manualWalkableInfo();
        const mmOk = !!info;
        const hasCell = (typeof a._cellIdx === 'number');

        // Always surface a single-line status in the Move Debug panel for quick screenshots.
        // (Do not depend on the tiny on-agent HUD being visible.)
        try{
          if(MVDBG && MVDBG.enabled && shortId==='main'){
            const mv = wrap._mv || {};
            const f = document.getElementById('md-flags');
            const d = (MODEL && MODEL.detailById) ? MODEL.detailById : {};
            const dMain = d && d.main ? d.main : null;
            const dCode = d && d.coding_agent ? d.coding_agent : null;
            if(f) f.textContent = [
              `main: mm=${mmOk?1:0} cellIdx=${hasCell?1:0} mode=${mv.mode||'—'} zone=${a._zone} walking=${wrap._walking?1:0}`,
              `detailToggle=${MODEL.showAgentDetail?1:0}`,
              `detail(main): st=${dMain?dMain.stNorm:'—'} show=${dMain? (dMain.show?1:0):'—'} txt=${dMain?JSON.stringify(String(dMain.txt||'').slice(0,60)):'—'}`,
              `detail(coding): st=${dCode?dCode.stNorm:'—'} show=${dCode? (dCode.show?1:0):'—'} txt=${dCode?JSON.stringify(String(dCode.txt||'').slice(0,60)):'—'}`,
            ].join(' | ');
          }
        }catch{}

        // Agent detail (what is it doing?)
        try{
          let detEl = wrap.querySelector('.detail');
          // Backward-compat: if node was created before we added .detail, inject it.
          if(!detEl){
            const nameEl = wrap.querySelector('.name');
            detEl = document.createElement('div');
            detEl.className = 'detail';
            if(nameEl && nameEl.parentNode){
              nameEl.insertAdjacentElement('afterend', detEl);
            }else{
              wrap.appendChild(detEl);
            }
          }
          const stRaw = String(a.state||'');
          const stNorm = (stRaw==='think')?'thinking':(stRaw==='reply')?'replying':(stRaw==='build')?'building':stRaw;
          const show = !!MODEL.showAgentDetail && stNorm !== 'wait' && stNorm !== 'idle';
          let txt = '';

          if(show){
            // Prefer statusText from backend (session_status), if present.
            const st = a && a.meta && typeof a.meta.statusText === 'string' ? a.meta.statusText : '';
            if(st) txt = st;

            // Otherwise, try to infer from most recent event.
            if(!txt){
              const evs = a && a.debug && a.debug.decision && Array.isArray(a.debug.decision.recentEvents) ? a.debug.decision.recentEvents : [];
              const last = evs && evs.length ? evs[evs.length-1] : null;
              const kind = last && last.kind ? String(last.kind) : '';
              const d = last && last.data ? last.data : null;
              if(kind === 'message_sending' && d && (d.contentPreview||d.content)){
                const pv = String(d.contentPreview||d.content||'').trim();
                txt = pv ? ('send: ' + pv.slice(0, 60)) : '';
              }else if(kind === 'before_tool_call' && d && d.toolName){
                txt = 'tool: ' + d.toolName;
                if(d.toolName==='exec' && d.command) txt += ' · ' + String(d.command).slice(0, 60);
                if(d.toolName==='sessions_spawn' && d.task) txt += ' · ' + String(d.task).slice(0, 60);
                if(d.toolName==='message' && d.message) txt += ' · ' + String(d.message).slice(0, 60);
                if(d.toolName==='web_fetch' && d.url) txt += ' · ' + String(d.url).slice(0, 60);
              }else if(stNorm==='tool'){
                // avoid redundant detail; state bubble already shows tool
                txt = '';
              }else if(stNorm==='thinking'){
                // avoid redundant detail; state bubble already shows thinking
                txt = '';
              }else if(stNorm==='replying'){
                // avoid redundant detail; state bubble already shows replying
                txt = '';
              }else if(stNorm==='building'){
                // avoid redundant detail; state bubble already shows building
                txt = '';
              }else if(stNorm==='error'){
                txt = 'error';
              }
            }
          }

          txt = (txt||'').replace(/\s+/g,' ').trim();

          // Persist for debugging (Move Debug panel)
          try{
            if(!MODEL.detailById) MODEL.detailById = {};
            MODEL.detailById[shortId] = {show:!!show, stRaw, stNorm, txt};
          }catch{}

          // Also emit a throttled debug line into Move Debug log (so we don't rely on spotting md-flags).
          try{
            if(MVDBG && MVDBG.enabled && shortId==='main'){
              const now = Date.now();
              if(!MODEL._lastDetailDbgMs || (now - MODEL._lastDetailDbgMs) > 1500){
                MODEL._lastDetailDbgMs = now;
                const d = MODEL.detailById || {};
                const dm = d.main || null;
                const dc = d.coding_agent || null;
                mvLog('main','DETAIL_DBG',{
                  toggle: !!MODEL.showAgentDetail,
                  main: dm ? {st:dm.stNorm, show:dm.show, txt:String(dm.txt||'').slice(0,60)} : null,
                  coding: dc ? {st:dc.stNorm, show:dc.show, txt:String(dc.txt||'').slice(0,60)} : null,
                });
              }
            }
          }catch{}

          if(detEl){
            detEl.textContent = txt;
            detEl.style.display = (show && txt) ? 'block' : 'none';
          }
        }catch{}

        // Debug HUD
        const hud = wrap.querySelector('.hud');
        if(hud){
          const lockLeft = Math.max(0, Math.round((wrap._lockedUntilMs||0) - Date.now()));
          const mv = wrap._mv || {};
          if(MVDBG && MVDBG.enabled){
            hud.style.display='';
            hud.textContent = [
              `zone: ${prevZone} → ${a._zone}`,
              `target: ${(prevTarget==null?'—':prevTarget)} → ${(hasCell?a._cellIdx:'—')}`,
              `mm: ${mmOk?1:0}  cellIdx: ${hasCell?1:0}  mode: ${mv.mode||'—'}`,
              `walking: ${wrap._walking?1:0}  lockLeft: ${lockLeft}ms`,
              `pathLen: ${mv.pathLen||0}  step: ${mv.step||0}`,
              `manualReady: ${MODEL.manualReady?1:0}`,
            ].join('\n');
          }else{
            hud.style.display='none';
          }
        }
        if(info){
          // When manualMap exists, NEVER move through non-walkable: always path on grid.
          // If we don't have a cell target for some reason, we still must not fall back to smooth movement.
          if(typeof a._cellIdx !== 'number'){
            try{ mvLog(a.id,'FAIL_NO_CELLIDX',{zone:a._zone, zoneChanged, targetChanged}); }catch{}
            continue;
          }

          if(zoneChanged || targetChanged){
            // While walking, keep current target unless zone changed.
            if(wrap._walking && !zoneChanged && Date.now() < (wrap._lockedUntilMs||0)){
              try{ mvLog(a.id,'SKIP_LOCK',{zone:a._zone,zoneChanged,targetChanged,lockLeft:Math.max(0,Math.round((wrap._lockedUntilMs||0)-Date.now()))}); }catch{}
              continue;
            }

            const curPx = parseFloat(wrap.dataset.px || String(a._px));
            const curPy = parseFloat(wrap.dataset.py || String(a._py));
            const sx0 = Math.max(0, Math.min(info.tx-1, Math.floor(curPx/100*info.tx)));
            const sy0 = Math.max(0, Math.min(info.ty-1, Math.floor(curPy/100*info.ty)));
            const approxStart = sy0*info.tx + sx0;
            const startIdx = nearestWalkable(info, approxStart);
            const endIdx = a._cellIdx;
            if(startIdx==null || !info.walk[endIdx]){
              // Can't compute a safe path; keep current position (no teleport through tables).
              try{ mvLog(a.id,'FAIL_BAD_START_END',{zone:a._zone, startIdx, endIdx, zoneChanged, targetChanged}); }catch{}
              continue;
            }
            if(startIdx===endIdx){
              try{ mvLog(a.id,'NOOP_ALREADY_THERE',{zone:a._zone, startIdx, endIdx, zoneChanged, targetChanged}); }catch{}
              continue;
            }

            // Lock target (shared with layoutAgentsByZone via localStorage)
            try{
              localStorage.setItem(`lobsterRoom.lock.${a.id}`, JSON.stringify({zone:a._zone, idx:endIdx, untilMs: Date.now()+10000}));
            }catch{}

            const mm = MODEL.manualMap;
            let pathIdx = [];
            if(!zoneChanged && targetChanged){
              pathIdx = zoneOnlyPath(mm, a._zone, startIdx, endIdx);
            }
            if(!pathIdx.length){
              pathIdx = manualPath(info, startIdx, endIdx);
            }

            // If unreachable (disconnected components), retarget to nearest reachable cell of the zone.
            if(!pathIdx.length){
              const altEnd = nearestReachableZoneCell(info, mm, startIdx, a._zone, startIdx);
              if(altEnd!=null && altEnd!==endIdx){
                endIdx = altEnd;
                try{ mvLog(a.id,'RETARGET_REACHABLE',{zone:a._zone, startIdx, endIdx}); }catch{}
                pathIdx = manualPath(info, startIdx, endIdx);
              }
            }

            // Micro-jitter guard: ignore tiny within-zone moves.
            if(!zoneChanged && pathIdx && pathIdx.length && pathIdx.length < 4){
              try{ mvLog(a.id,'SKIP_MICRO',{zone:a._zone, startIdx, endIdx, pathLen:pathIdx.length}); }catch{}
              continue;
            }

            if(pathIdx && pathIdx.length >= 2){
              try{ mvLog(a.id,'PLAN',{zone:a._zone, startIdx, endIdx, pathLen:pathIdx.length, zoneChanged, targetChanged, lockLeft:Math.max(0,Math.round((wrap._lockedUntilMs||0)-Date.now()))}); }catch{}
              // Important: for grid-constrained movement, do NOT jitter path points.
              // Jitter can push an otherwise-walkable cell center into a nearby blocked/obstacle area,
              // which looks like the agent is "cutting through" a table.
              const pts = pathIdx.map(idx=>{
                const x=(idx%info.tx)+0.5;
                const y=((idx/info.tx)|0)+0.5;
                return [(x/info.tx)*100, (y/info.ty)*100];
              });
              try{ mvLog(a.id,'START',{zone:a._zone, startIdx, endIdx, pathLen:pathIdx.length}); }catch{}
              startNodePath(wrap, pts, {lockMs:10000});
            }else{
              // If path not found, do nothing (stay put) rather than crossing non-walkable.
              try{ mvLog(a.id,'FAIL_NO_PATH',{zone:a._zone, startIdx, endIdx, zoneChanged, targetChanged, pathLen: (pathIdx?pathIdx.length:0)}); }catch{}
            }
            continue;
          }
          // If no target/zone change, leave current animation running.
          // Critical: in manualMap mode we must NOT apply the default smooth movement,
          // otherwise each poll will lerp/teleport in a straight line and can cross non-walkable.
          try{ wrap._mv = wrap._mv || {}; if(!wrap._mv.mode) wrap._mv.mode = 'grid-hold'; }catch{}
          continue;
        }

        // Default smooth movement
        try{ wrap._mv = wrap._mv || {}; wrap._mv.mode = 'smooth'; }catch{}
        // If manualMap exists but we got here, that's a bug (it will draw a straight line across non-walkable).
        try{
          const mm = MODEL.manualMap;
          if(mm && mm.tx && mm.ty && Array.isArray(mm.cells)){
            mvLog(a.id,'BUG_SMOOTH_IN_MANUAL',{zone:a._zone, state:a.state||null, zoneChanged, targetChanged});
          }
        }catch{}
        const prevPx = parseFloat(wrap.dataset.px || String(a._px));
        const prevPy = parseFloat(wrap.dataset.py || String(a._py));
        const dx = (a._px - prevPx) / 100 * w;
        const dy = (a._py - prevPy) / 100 * h;
        const dist = Math.hypot(dx, dy);

        // Speed model: near -> slower, far -> faster.
        const slow = 120; // px/s
        const fast = 520; // px/s
        const t = Math.max(0, Math.min(1, dist / 520));
        const speed = slow + (fast - slow) * t;
        const dur = Math.round(Math.max(200, Math.min(1400, (dist / Math.max(1, speed)) * 1000)));
        wrap.style.setProperty('--moveDur', dur + 'ms');

        wrap.dataset.px = String(a._px);
        wrap.dataset.py = String(a._py);
        wrap.style.left = a._px + '%';
        wrap.style.top  = a._py + '%';
      }
    }

    function bindZoneHover(){
      const svg = document.querySelector('.roommap');
      if(!svg) return;
      const g = svg.querySelector('#zones');
      if(!g) return;

      g.querySelectorAll('[data-zone]').forEach(el => {
        el.addEventListener('mouseenter', () => {
          const z = el.getAttribute('data-zone');
          MODEL.lastZoneFocus = z;
        });
        el.addEventListener('mouseleave', () => {
          MODEL.lastZoneFocus = null;
        });
        el.addEventListener('click', () => {
          const z = el.getAttribute('data-zone');
          // For now: just a tiny affordance via console + future hook.
          console.log('[lobster-room] zone clicked:', z);
        });
      });
    }

    async function refreshActivity(){
      // Lightweight build/activity monitor. If file exists, show it; otherwise keep blank.
      const el = document.getElementById('activity');
      if(!el) return;
      try{
        // Note: assets handler may not allow .json in some deployments; use .js extension with JSON body.
        const r = await fetch('./assets/user/activity.js?ts=' + Date.now(), {cache:'no-store'});
        if(!r.ok){ el.textContent = ''; return; }
        const txt = await r.text();
        const j = JSON.parse(txt);
        if(!j || !j.status){ el.textContent=''; MODEL.activity=null; return; }

        const ageMs = (typeof j.updatedAt === 'number') ? (Date.now() - j.updatedAt) : null;
        const ageSec = (ageMs==null) ? null : Math.max(0, Math.round(ageMs/1000));
        // "working" is only valid if we have a fresh update.
        const fresh = (ageMs!=null && isFinite(ageMs) && ageMs < 45*1000);
        const effectiveStatus = (j.status === 'working' && !fresh) ? 'paused' : j.status;
        const ageTxt = (ageSec==null) ? '' : (' · ' + ageSec + 's ago');

        const who = MODEL.selfName || 'Zac';
        let msg = '';
        if(effectiveStatus === 'working'){
          msg = `${who}: WORKING ${j.task||''} ${j.step||''} — ${j.detail||''}${ageTxt}`;
        }else if(effectiveStatus === 'done'){
          msg = `${who}: DONE ${j.task||''} ${j.step||''} — ${j.detail||''}${ageTxt}`;
        }else if(effectiveStatus === 'blocked'){
          msg = `${who}: BLOCKED ${j.task||''} ${j.step||''} — ${j.detail||''}${ageTxt}`;
        }else{
          msg = `${who}: PAUSED ${j.task||''} ${j.step||''} — ${j.detail||''}${ageTxt}`;
        }

        el.textContent = msg.replace(/\s+/g,' ').trim();
        MODEL.activity = {
          status: effectiveStatus,
          task: j.task || null,
          step: j.step || null,
          detail: j.detail || null,
          updatedAt: (typeof j.updatedAt === 'number') ? j.updatedAt : null,
          fresh,
        };
      }catch{ el.textContent=''; MODEL.activity = null; }
    }

    async function tick(){
      try{
        // On cold load, wait until manual map has been loaded (server or local fallback)
        // to avoid initial "teleport/jitter" caused by placing with empty pools.
        if(MODEL.manualReady === false) return;
        // Use relative URL so Lobster Room can be mounted under a subpath (e.g. /lobster-room/).
        const res = await fetch('./api/lobster-room', {cache:'no-store'});
        if(res.ok){
          const data = await res.json();

          // Build tag (backend)
          MODEL.buildTag = data.buildTag || '';

          // Agents from API.
          MODEL.agents = (data.agents || []).map(a => ({
            id: a.id,
            name: a.name,
            state: a.state || 'wait',
            x: a.x,
            y: a.y,
            meta: a.meta || null,
            debug: a.debug,
          }));
          // Keep last-known-good snapshot so we can keep rendering on transient errors.
          MODEL.lastGoodAgents = MODEL.agents;
          MODEL.lastGoodAt = Date.now();
          MODEL.lastApiError = null;

          // Activity debug: log state changes + recentEvents into the Move Debug panel (HUD).
          try{
            MVDBG._actPrev = MVDBG._actPrev || {};
            for(const a of MODEL.agents){
              const aid = String(a && a.id || '');
              const prev = MVDBG._actPrev[aid] || {};
              const st = String(a && a.state || '');
              const actState = a && a.debug && a.debug.decision ? String(a.debug.decision.activityState||'') : '';
              const lastEventMs = a && a.debug && a.debug.decision ? a.debug.decision.lastEventMs : null;
              const sinceMs = a && a.debug && a.debug.decision ? a.debug.decision.sinceMs : null;
              const qd = a && a.meta ? a.meta.queueDepth : null;
              const evN = a && a.debug && a.debug.decision && Array.isArray(a.debug.decision.recentEvents) ? a.debug.decision.recentEvents.length : null;

              const changed = (prev.state!==st) || (prev.activityState!==actState);
              const heartbeat = (!prev._t || (Date.now()-prev._t) > 10000);
              if(changed || heartbeat){
                mvActLog(aid, changed?'STATE':'BEAT', {
                  buildTag: MODEL.buildTag || '',
                  state: st,
                  activityState: actState,
                  queueDepth: qd,
                  lastEventMs,
                  sinceMs,
                  recentEvents: evN,
                });
                MVDBG._actPrev[aid] = {state: st, activityState: actState, _t: Date.now()};
              }
            }
          }catch{}

          // Derive a display name for footer activity.
          MODEL.selfName = (MODEL.agents.find(a=>String(a.id||'')==='main')?.name) || (MODEL.agents[0]?.name) || 'main';

          // If we have a recent build activity ping, surface it as a clearer state in the UI.
          // (Does not change backend runtime state; purely a monitoring affordance.)
          try{
            const act = MODEL.activity;
            const active = !!(act && act.status === 'working' && act.fresh);
            if(active){
              const single = MODEL.agents.length === 1;
              for(const a of MODEL.agents){
                const id = String(a && a.id || '').toLowerCase();
                const name = String(a && a.name || '').toLowerCase();
                const isZac = single || id === 'main' || name === 'main' || id.includes('main') || name.includes('zac') || id.includes('zac');
                if(a && isZac && a.state === 'wait') a.state = 'build';
              }
            }
          }catch{}

          // Optional: backend can tell frontend how often to poll.
          if(typeof data.pollSeconds === 'number' && isFinite(data.pollSeconds)){
            MODEL.pollMs = Math.max(1000, Math.floor(data.pollSeconds * 1000));
          }

          renderAgents();
          refreshActivity();
          document.getElementById('ts').textContent = 'Updated: ' + new Date().toLocaleString();
          document.getElementById('api').textContent = 'API: /api/lobster-room';
          document.getElementById('data-source').textContent = 'api';
          return;
        }
        throw new Error('HTTP ' + res.status);
      }catch(e){
        // Do NOT clear the scene on transient API errors; keep last-known-good agents on screen.
        // (Mobile networks / brief proxy hiccups should not make all lobsters disappear.)
        refreshActivity();
        MODEL.lastApiError = { at: Date.now(), message: (e && e.message) ? String(e.message) : 'error' };
        document.getElementById('ts').textContent = 'Update failed (showing last state): ' + new Date().toLocaleString();
        document.getElementById('api').textContent = 'API error: ' + (MODEL.lastApiError.message || 'error');
        document.getElementById('data-source').textContent = 'error';
      }
    }

    // --- Message Feed ---
    const FEED = {
      show: false,

      // v3: human-friendly rows (newest-first) with folded low-level ops.
      rows: [],

      // v2/raw: latest polled items/tasks (still useful for debug and segment details)
      tasks: [],
      items: [], // newest-first from API

      latest: null,

      // Selection
      selected: null,
      selectedType: '', // 'row' | 'item' | 'task'
      showRawDetail: false,

      // UI toggles
      showRawList: false, // "Show raw (scrubbed)"

      pollMs: 2000,
      summaryText: '',
      summaryMeta: null,
      devSpawnStatus: '',

      // "since last viewed" anchor (set when panel opens; persisted when panel closes)
      lastViewedMs: null,
      _agentFilter: '',
    };

    function feedTime(ts){
      try{
        const d = new Date(ts);
        return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
      }catch{return '—'}
    }

    function feedMaskUrls(s){
      if(typeof s !== 'string') return s;
      if(s === '[URL]') return s;

      return s
        .replace(/https?://[^s"'<>]+/gi, '[URL]')
        .replace(/localhost(?::d+)?(?:/[w-.~%!$&'()*+,;=:@/]*)?/gi, '[URL]')
        .replace(/127.0.0.1(?::d+)?(?:/[w-.~%!$&'()*+,;=:@/]*)?/gi, '[URL]');
    }

    function feedMaskSessionKey(s){
      if(typeof s !== 'string') return s;
      if(!s) return s;

      return s.replace(/agent:([^:s"'<>]+):[^s"'<>]+/g, (_m, agentId)=>{
        const a = String(agentId || '').trim();
        return a ? ('agent:' + a + ':…') : '[SESSION]';
      });
    }

    function feedMaskOpaqueId(s){
      if(typeof s !== 'string') return s;
      if(s === '[URL]') return s;
      if(!s) return s;

      const maskOne = (tok)=>{
        const t = String(tok || '').trim();
        if(!t) return tok;
        if(t.length < 18) return tok;

        const isHex = /^[a-f0-9]+$/i.test(t) && t.length >= 24;
        const isBase64ish = /^[A-Za-z0-9+/=_-]+$/.test(t) && t.length >= 24;
        const isCall = /^call_[A-Za-z0-9_-]{6,}$/i.test(t);
        const isFc = /^fc_[A-Za-z0-9_-]{6,}$/i.test(t);
        if(isCall || isFc) return '[OC_ID_REDACTED]';

        if(isHex || isBase64ish){
          const head = t.slice(0, 4);
          const tail = t.slice(-4);
          return '[ID:' + head + '…' + tail + ']';
        }
        return tok;
      };

      let out = s;
      out = out.replace(/(call_[A-Za-z0-9_-]{8,})/gi, (m)=> maskOne(m));
      out = out.replace(/(fc_[A-Za-z0-9_-]{8,})/gi, (m)=> maskOne(m));
      out = out.replace(/[a-f0-9]{24,}/gi, (m)=> maskOne(m));
      out = out.replace(/[A-Za-z0-9+/=_-]{24,}/g, (m)=> maskOne(m));
      return out;
    }

    function feedScrubValue(v, k){
      const key = (typeof k === 'string') ? k : '';

      if(typeof v === 'string'){
        let masked = feedMaskUrls(v);
        masked = feedMaskSessionKey(masked);
        masked = feedMaskOpaqueId(masked);
        return masked;
      }
      if(Array.isArray(v)) return v.map((x)=> feedScrubValue(x, key));
      if(v && typeof v === 'object'){
        const out = {};
        for(const kk of Object.keys(v)) out[kk] = feedScrubValue(v[kk], kk);
        return out;
      }
      return v;
    }

    function feedRowKey(r){
      if(!r || typeof r !== 'object') return '';
      return String(r.id || r._id || r.ts || '');
    }

    function feedItemKey(it){
      const ts = (it && typeof it.ts === 'number') ? String(it.ts) : '0';
      const k = String(it && (it.kind||'') || '');
      const a = String(it && (it.agentId||'') || '');
      const t = String(it && (it.toolName||'') || '');
      const sk = String(it && (it.sessionKey||'') || '');
      return [ts,k,a,t,sk].join('|');
    }

    function feedFindTaskItemsBySessionKey(sk){
      if(!sk) return [];
      const tasks = Array.isArray(FEED.tasks) ? FEED.tasks : [];
      const t = tasks.find(x=> String(x && x.sessionKey || '') === String(sk));
      return (t && Array.isArray(t.items)) ? t.items : [];
    }

    function feedRender(){
      const listEl = document.getElementById('feed-list');
      const detailEl = document.getElementById('feed-detail');
      const statusEl = document.getElementById('feed-status');
      const expandBtn = document.getElementById('feed-expand');
      const sumBody = document.getElementById('feed-summary-body');
      const sumSegBtn = document.getElementById('feed-sum-seg');
      if(!listEl) return;

      const rows = Array.isArray(FEED.rows) ? FEED.rows : [];
      const items = Array.isArray(FEED.items) ? FEED.items : [];

      if(statusEl){
        const base = FEED.showRawList ? (items.length ? (String(items.length) + ' raw events') : '—')
          : (rows.length ? (String(rows.length) + ' rows') : '—');
        const extra = (FEED.devSpawnStatus || '').trim();
        statusEl.textContent = extra ? (base + ' · ' + extra) : base;
      }

      if(sumBody){
        const txt = (FEED.summaryText || '').trim();
        sumBody.textContent = txt ? txt : '(no summary yet)';
      }

      listEl.innerHTML = '';

      if(FEED.showRawList){
        for(const it of items){
          const row = document.createElement('div');
          const isSel = (FEED.selectedType === 'item' && FEED.selected && feedItemKey(FEED.selected) === feedItemKey(it));
          row.className = 'feed-item' + (isSel ? ' sel' : '');
          row.addEventListener('click', ()=>{ FEED.selected = it; FEED.selectedType = 'item'; FEED.showRawDetail=false; feedRender(); });

          const time = document.createElement('div');
          time.className = 'feed-time';
          time.textContent = feedTime(it.ts);

          const badge = document.createElement('div');
          badge.className = 'feed-badge';
          const k = String(it.kind || '');
          const tn = (it.toolName ? String(it.toolName) : '');
          badge.textContent = tn ? (k + ':' + tn) : k;

          const main = document.createElement('div');
          main.className = 'feed-main';

          const line1 = document.createElement('div');
          line1.className = 'feed-line';
          const agent = document.createElement('div');
          agent.className = 'feed-agent';
          agent.textContent = it.agentId || '—';
          const preview = document.createElement('div');
          preview.className = 'feed-preview';
          preview.textContent = (it.preview || '') ? String(it.preview) : (k || '(event)');
          line1.appendChild(agent);
          line1.appendChild(preview);
          main.appendChild(line1);

          row.appendChild(time);
          row.appendChild(badge);
          row.appendChild(main);
          listEl.appendChild(row);
        }
      }else{
        for(const r of rows){
          const row = document.createElement('div');
          const isSel = (FEED.selectedType === 'row' && FEED.selected && feedRowKey(FEED.selected) === feedRowKey(r));
          row.className = 'feed-item' + (isSel ? ' sel' : '');
          row.addEventListener('click', ()=>{ FEED.selected = r; FEED.selectedType = 'row'; FEED.showRawDetail=false; feedRender(); });

          const time = document.createElement('div');
          time.className = 'feed-time';
          time.textContent = feedTime(r.ts);

          const badge = document.createElement('div');
          badge.className = 'feed-badge';
          badge.textContent = (r.rowType === 'fold') ? 'ops' : (String(r.kind || 'event') || 'event');

          const main = document.createElement('div');
          main.className = 'feed-main';

          const line1 = document.createElement('div');
          line1.className = 'feed-line';
          const agent = document.createElement('div');
          agent.className = 'feed-agent';
          agent.textContent = r.agentId || '—';
          const preview = document.createElement('div');
          preview.className = 'feed-preview';
          preview.textContent = String(r.action || '').trim() || '(event)';
          line1.appendChild(agent);
          line1.appendChild(preview);
          main.appendChild(line1);

          row.appendChild(time);
          row.appendChild(badge);
          row.appendChild(main);
          listEl.appendChild(row);
        }
      }

      if(FEED.selected){
        detailEl.style.display = 'block';

        let seg = null;
        if(FEED.selectedType === 'row' && FEED.selected && FEED.selected.rowType === 'fold' && FEED.selected.segment){
          seg = FEED.selected.segment;
        }
        if(sumSegBtn) sumSegBtn.style.display = seg ? '' : 'none';

        if(FEED.selectedType === 'row'){
          const base = {
            id: FEED.selected.id,
            ts: FEED.selected.ts,
            rowType: FEED.selected.rowType,
            kind: FEED.selected.kind,
            agentId: FEED.selected.agentId,
            sessionKey: FEED.selected.sessionKey,
            action: FEED.selected.action,
            segment: FEED.selected.segment || null,
          };

          let payload = base;
          if(FEED.showRawDetail && FEED.selected.sessionKey && FEED.selected.segment){
            const raw = feedFindTaskItemsBySessionKey(FEED.selected.sessionKey);
            const a = Number(FEED.selected.segment.startTs||0);
            const b = Number(FEED.selected.segment.endTs||0);
            const picked = raw.filter(x=> (x.ts||0) >= a && (x.ts||0) <= b);
            payload = Object.assign({}, base, { rawItems: picked });
          }

          detailEl.textContent = JSON.stringify(feedScrubValue(payload, 'payload'), null, 2);

          if(expandBtn){
            const canExpand = !!(FEED.selected.sessionKey && FEED.selected.segment);
            expandBtn.style.display = canExpand ? '' : 'none';
            expandBtn.textContent = FEED.showRawDetail ? 'Hide raw (scrubbed)' : 'Show raw (scrubbed)';
          }
        }else if(FEED.selectedType === 'item'){
          const base = {
            ts: FEED.selected.ts,
            kind: FEED.selected.kind,
            agentId: FEED.selected.agentId,
            sessionKey: FEED.selected.sessionKey,
            toolName: FEED.selected.toolName,
            durationMs: FEED.selected.durationMs,
            success: FEED.selected.success,
            error: FEED.selected.error,
            preview: FEED.selected.preview,
          };
          const payload = FEED.showRawDetail ? FEED.selected : base;
          detailEl.textContent = JSON.stringify(feedScrubValue(payload, 'payload'), null, 2);

          if(expandBtn){
            expandBtn.style.display = '';
            expandBtn.textContent = FEED.showRawDetail ? 'Hide raw (scrubbed)' : 'Show raw (scrubbed)';
          }
        }else if(FEED.selectedType === 'task'){
          const payload = {
            id: FEED.selected.id,
            sessionKey: FEED.selected.sessionKey,
            agentId: FEED.selected.agentId,
            status: FEED.selected.status,
            startTs: FEED.selected.startTs,
            endTs: FEED.selected.endTs,
            title: FEED.selected.title,
            summary: FEED.selected.summary,
            items: (FEED.showRawDetail && Array.isArray(FEED.selected.items)) ? FEED.selected.items : undefined,
          };
          detailEl.textContent = JSON.stringify(feedScrubValue(payload, 'payload'), null, 2);

          if(expandBtn){
            expandBtn.style.display = Array.isArray(FEED.selected.items) ? '' : 'none';
            expandBtn.textContent = FEED.showRawDetail ? 'Hide raw (scrubbed)' : 'Show raw (scrubbed)';
          }
        }else{
          detailEl.textContent = JSON.stringify(feedScrubValue(FEED.selected, 'payload'), null, 2);
          if(expandBtn) expandBtn.style.display='none';
        }
      }else{
        detailEl.style.display = 'none';
        if(expandBtn) expandBtn.style.display='none';
        if(sumSegBtn) sumSegBtn.style.display='none';
      }
    }

    async function feedPollOnce(){
      const agentSel = document.getElementById('feed-agent');
      const agentId = agentSel ? agentSel.value : '';

      try{
        const data = await apiPostJson('./api/lobster-room', {
          op: 'feedGet',
          limit: 400,
          agentId: agentId || '',
          includeRaw: true,
          version: 3,
        });

        if(data && data.ok){
          if(typeof FEED._agentFilter !== 'string') FEED._agentFilter = '';
          if(FEED._agentFilter !== (agentId||'')){
            FEED._agentFilter = (agentId||'');
            FEED.selected = null;
            FEED.selectedType = '';
            FEED.showRawDetail = false;
          }

          FEED.latest = data.latest || null;
          FEED.rows = Array.isArray(data.rows) ? data.rows : [];
          FEED.tasks = Array.isArray(data.tasks) ? data.tasks : [];
          FEED.items = Array.isArray(data.items) ? data.items : [];

          const agents = [...new Set((FEED.tasks||[]).map(x=>x.agentId).filter(Boolean))].sort();
          if(agentSel){
            const cur = agentSel.value;
            const opts = [''].concat(agents);
            agentSel.innerHTML = '';
            for(const a of opts){
              const o = document.createElement('option');
              o.value = a;
              o.textContent = a ? a : 'All agents';
              agentSel.appendChild(o);
            }
            agentSel.value = cur;
          }

          if(FEED.selected){
            if(FEED.selectedType === 'row'){
              const k = feedRowKey(FEED.selected);
              const m = (FEED.rows||[]).find(x=> feedRowKey(x)===k);
              if(m) FEED.selected = m;
            }
            if(FEED.selectedType === 'task'){
              const m = (FEED.tasks||[]).find(x=>x.id===FEED.selected.id);
              if(m) FEED.selected = m;
            }
            if(FEED.selectedType === 'item'){
              const k = feedItemKey(FEED.selected);
              const m = (FEED.items||[]).find(x=> feedItemKey(x)===k);
              if(m) FEED.selected = m;
            }
          }

          feedRender();
        }
      }catch{
        // ignore
      }
    }

    async function feedSummarize(scope){
      const btn60 = document.getElementById('feed-sum-60m');
      const btnSince = document.getElementById('feed-sum-since');
      const btnSeg = document.getElementById('feed-sum-seg');

      const disableAll = (v)=>{
        for(const b of [btn60, btnSince, btnSeg]){
          if(!b) continue;
          b.disabled = !!v;
        }
      };

      let body = {maxItems: 320};
      const now = Date.now();

      if(scope === 'seg'){
        const r = (FEED.selectedType==='row') ? FEED.selected : null;
        if(!(r && r.sessionKey && r.segment)) return;
        body = Object.assign(body, { sessionKey: r.sessionKey, startMs: r.segment.startTs, endMs: r.segment.endTs });
      }else if(scope === 'since'){
        const since = (typeof FEED.lastViewedMs === 'number' && isFinite(FEED.lastViewedMs)) ? FEED.lastViewedMs : (now - 60*60*1000);
        body = Object.assign(body, { sinceMs: since });
      }else{
        body = Object.assign(body, { sinceMs: now - 60*60*1000 });
      }

      FEED.summaryText = 'Summarizing…';
      FEED.summaryMeta = { at: Date.now(), scope };
      feedRender();

      disableAll(true);
      try{
        const r = await apiPostJson('./api/lobster-room', { op: 'feedSummarize', ...body });
        if(r && r.ok){
          FEED.summaryText = String(r.summary || '').trim() || '(empty summary)';
        }else if(r && r.error === 'llm_not_configured'){
          FEED.summaryText = 'LLM summary not configured on this gateway.';
        }else{
          FEED.summaryText = 'Summary failed.';
        }
      }catch{
        FEED.summaryText = 'Summary failed.';
      }finally{
        disableAll(false);
        feedRender();
      }
    }

    function feedInit(){
      const panel = document.getElementById('feed-panel');
      const btnOpen = document.getElementById('btn-feed');
      const btnToggle = document.getElementById('feed-toggle');
      const btnClear = document.getElementById('feed-clear');
      const agentSel = document.getElementById('feed-agent');
      const expandBtn = document.getElementById('feed-expand');
      const devSpawnBtn = document.getElementById('feed-dev-spawn');

      const btn60 = document.getElementById('feed-sum-60m');
      const btnSince = document.getElementById('feed-sum-since');
      const btnSeg = document.getElementById('feed-sum-seg');
      const rawToggle = document.getElementById('feed-raw-toggle');

      const devEnabled = (()=>{
        try{ return new URLSearchParams(location.search).get('dev') === '1'; }catch{ return false; }
      })();

      function loadLastViewed(){
        try{
          const v = Number(localStorage.getItem('lobsterRoom.feed.lastViewedMs') || '0');
          return (isFinite(v) && v>0) ? v : null;
        }catch{ return null; }
      }
      function saveLastViewed(ms){
        try{ localStorage.setItem('lobsterRoom.feed.lastViewedMs', String(ms||Date.now())); }catch{}
      }

      function setShow(v){
        FEED.show = !!v;
        if(panel) panel.classList.toggle('show', FEED.show);

        if(FEED.show){
          FEED.lastViewedMs = loadLastViewed();
          feedPollOnce();
        }else{
          saveLastViewed(Date.now());
        }

        if(FEED.show && devEnabled && panel){
          try{
            const r = panel.getBoundingClientRect();
            console.log('[feed-panel] rect', {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}, 'viewport', {w: window.innerWidth, h: window.innerHeight});
          }catch{}
        }
      }

      if(rawToggle){
        try{ FEED.showRawList = localStorage.getItem('lobsterRoom.feed.showRaw') === '1'; }catch{}
        rawToggle.checked = !!FEED.showRawList;
        rawToggle.addEventListener('change', ()=>{
          FEED.showRawList = !!rawToggle.checked;
          try{ localStorage.setItem('lobsterRoom.feed.showRaw', FEED.showRawList?'1':'0'); }catch{}
          FEED.selected = null;
          FEED.selectedType = '';
          FEED.showRawDetail = false;
          feedRender();
        });
      }

      if(btnOpen) btnOpen.addEventListener('click', ()=> setShow(!FEED.show));
      if(btnToggle) btnToggle.addEventListener('click', ()=> setShow(false));
      if(btnClear) btnClear.addEventListener('click', ()=>{ FEED.selected = null; FEED.selectedType=''; FEED.showRawDetail=false; feedRender(); });
      if(agentSel) agentSel.addEventListener('change', ()=> feedPollOnce());
      if(expandBtn) expandBtn.addEventListener('click', ()=>{ FEED.showRawDetail = !FEED.showRawDetail; feedRender(); });

      if(btn60) btn60.addEventListener('click', ()=> feedSummarize('60m'));
      if(btnSince) btnSince.addEventListener('click', ()=> feedSummarize('since'));
      if(btnSeg) btnSeg.addEventListener('click', ()=> feedSummarize('seg'));

      if(devSpawnBtn) devSpawnBtn.style.display = devEnabled ? '' : 'none';
      if(devSpawnBtn && devEnabled){
        devSpawnBtn.addEventListener('click', async ()=>{
          devSpawnBtn.disabled = true;
          const old = devSpawnBtn.textContent;
          devSpawnBtn.textContent = 'Spawning…';
          FEED.devSpawnStatus = '';
          feedRender();
          try{
            const r = await apiPostJson('./api/lobster-room', {
              op: 'feedDevSpawn',
              spawnAgentId: 'coding_agent',
              label: 'QA: multi-agent validation',
              task: 'Quick QA test task: respond with a short message and then finish.',
            });

            if(!r || !r.ok){
              const err = (r && (r.error || r.status)) ? String(r.error || r.status) : 'spawn_failed';
              const detail = (r && r.detail) ? String(r.detail) : '';
              FEED.devSpawnStatus = ('dev spawn failed: ' + err + (detail ? (' · ' + detail.slice(0, 80)) : '')).slice(0, 140);
              feedRender();
              return;
            }

            await feedPollOnce();
          }catch(e){
            FEED.devSpawnStatus = ('dev spawn failed: ' + String(e && e.message ? e.message : e)).slice(0, 140);
            feedRender();
          }finally{
            devSpawnBtn.textContent = old || 'Dev: spawn coding_agent';
            devSpawnBtn.disabled = false;
          }
        });
      }

      setShow(false);
      setInterval(()=>{ if(FEED.show) feedPollOnce(); }, FEED.pollMs);
    }

    function init(){
      feedInit();
      renderLegend();
      bindZoneHover();
      mvInitUI();
      tick();

      MODEL.pollMs = 2000;
      let timer = setInterval(tick, MODEL.pollMs);
      // If backend changes pollSeconds, restart the interval.
      setInterval(() => {
        if(MODEL.pollMs && timer && MODEL._pollMsLast !== MODEL.pollMs){
          clearInterval(timer);
          timer = setInterval(tick, MODEL.pollMs);
          MODEL._pollMsLast = MODEL.pollMs;
        }
      }, 500);

      // Settings
      const backdrop = document.getElementById('settings-backdrop');
      const btnSettings = document.getElementById('btn-settings');
      const btnClose = document.getElementById('btn-settings-close');
      const roomSelect = document.getElementById('room-select');
      const btnUpload = document.getElementById('btn-upload-room');
      const btnReset = document.getElementById('btn-reset-room');
      const btnDeleteRoom = document.getElementById('btn-delete-room');
      const fileInput = document.getElementById('room-file');
      const statusEl = document.getElementById('room-status');
      const bgOp = document.getElementById('bg-opacity');
      const bgOpVal = document.getElementById('bg-opacity-val');
      const lobsterSize = document.getElementById('lobster-size');
      const lobsterSizeVal = document.getElementById('lobster-size-val');
      const toggleRegions = document.getElementById('toggle-regions');
      const toggleMvdbg = document.getElementById('toggle-mvdbg');
      const toggleAgentDetail = document.getElementById('toggle-agent-detail');
      const agentLabelsStatus = document.getElementById('agent-labels-status');
      const btnAgentLabelsOpen = document.getElementById('btn-agent-labels-open');

      // Labels modal
      const labelsBackdrop = document.getElementById('labels-backdrop');
      const btnLabelsClose = document.getElementById('btn-labels-close');
      const btnLabelsAdd = document.getElementById('btn-labels-add');
      const btnLabelsSave = document.getElementById('btn-labels-save');
      const labelsList = document.getElementById('labels-list');
      const labelsStatus = document.getElementById('labels-status');

      // Room Editor
      const brushSeg = document.getElementById('brush-seg');
      const sizeSeg = document.getElementById('size-seg');
      const editorCanvas = document.getElementById('editor-canvas');
      const btnClearEditor = document.getElementById('btn-clear-editor');
      const btnSaveEditor = document.getElementById('btn-save-editor');
      const editorStatus = document.getElementById('editor-status');

      const openSettings = ()=>{
        backdrop.classList.add('show');
        refreshRoomsList();
        // Load agent label mapping
        (async ()=>{
          if(!agentLabelsTa) return;
          try{
            const r = await fetch('./api/agent-labels?ts=' + Date.now(), {cache:'no-store'});
            const j = r.ok ? await r.json() : null;
            if(j && j.ok && j.labels && typeof j.labels === 'object'){
              agentLabelsTa.value = JSON.stringify(j.labels, null, 2);
              if(agentLabelsStatus) agentLabelsStatus.textContent = '';
            }
          }catch{}
        })();

        // Ensure editor background renders immediately (room-bg may already be loaded).
        setTimeout(()=>{
          try{ renderEditor(); }catch{}
          const bg = document.getElementById('room-bg');
          if(bg && !bg.complete) bg.onload = ()=>{ try{ renderEditor(); }catch{} };
        }, 0);
      };
      const closeSettings = ()=> backdrop.classList.remove('show');

      btnSettings.addEventListener('click', openSettings);
      btnClose.addEventListener('click', closeSettings);
      backdrop.addEventListener('click', (e)=>{ if(e.target===backdrop) closeSettings(); });

      async function refreshRoomBg(){
        applyBgOpacity();
        try{
          const r = await fetch('./api/room-image/info', {cache:'no-store'});
          const j = r.ok ? await r.json() : null;
          const room = document.getElementById('room');
          const img = document.getElementById('room-bg');
          room.classList.add('has-bg');
          img.onload = () => {
            ensureLayout(false);
            ensureTiles(false);
            renderTileOverlay();
            // If Settings is open, re-render the editor preview background as well.
            try{
              const backdrop = document.getElementById('settings-backdrop');
              if(backdrop && backdrop.classList.contains('show')) renderEditor();
            }catch{}
          };
          // Cache-busting strategy A: use versioned URL param derived from room-image/info.updatedAt.
          // Backend serves ./api/room-image with long-lived immutable caching.
          img.src = './api/room-image?v=' + ((j && j.updatedAt) ? j.updatedAt : 0);
          const nm = (j && j.roomName) ? j.roomName : '—';
          statusEl.textContent = 'Current room: ' + nm;
        }catch{
          statusEl.textContent = 'Current: (failed to load room image status)';
        }
      }

      async function refreshRoomsList(){
        if(!roomSelect) return;
        try{
          const j = await apiGetJson('./api/rooms?ts=' + Date.now());
          if(!j || !j.ok) return;
          roomSelect.innerHTML = '';
          for(const r of (j.rooms || [])){
            const opt = document.createElement('option');
            opt.value = r.id;
            opt.textContent = r.name || r.id;
            if(r.id === j.activeRoomId) opt.selected = true;
            roomSelect.appendChild(opt);
          }
          // Default room cannot be deleted.
          if(btnDeleteRoom){
            btnDeleteRoom.style.display = (j.activeRoomId && j.activeRoomId !== 'default') ? '' : 'none';
          }
        }catch{}
      }

      function applyBgOpacity(){
        const room = document.getElementById('room');
        const vRaw = (bgOp && bgOp.value) ? parseFloat(bgOp.value) : 0.8;
        const v = isFinite(vRaw) ? Math.max(0.0, Math.min(1, vRaw)) : 0.8;
        room.style.setProperty('--bgOpacity', String(v));
        if(bgOpVal) bgOpVal.textContent = Math.round(v*100) + '%';
        try{ localStorage.setItem('lobsterRoom.bgOpacity', String(v)); }catch{}
      }

      (function initBgOpacity(){
        let v = 0.8;
        try{ const s = localStorage.getItem('lobsterRoom.bgOpacity'); if(s) v = parseFloat(s); }catch{}
        if(!isFinite(v)) v = 0.8;
        v = Math.max(0.0, Math.min(1, v));
        if(bgOp) bgOp.value = String(v);
        applyBgOpacity();
        if(bgOp) bgOp.addEventListener('input', applyBgOpacity);
        if(bgOp) bgOp.addEventListener('change', applyBgOpacity);
      })();

      function applyLobsterSize(){
        const room = document.getElementById('room');
        const vRaw = (lobsterSize && lobsterSize.value) ? parseFloat(lobsterSize.value) : 38;
        const v = isFinite(vRaw) ? Math.max(18, Math.min(72, Math.round(vRaw))) : 38;
        room.style.setProperty('--lobsterSize', v + 'px');
        if(lobsterSizeVal) lobsterSizeVal.textContent = v + 'px';
        try{ localStorage.setItem('lobsterRoom.lobsterSize', String(v)); }catch{}
      }
      (function initLobsterSize(){
        let v = 38;
        try{ const s = localStorage.getItem('lobsterRoom.lobsterSize'); if(s) v = parseFloat(s); }catch{}
        if(!isFinite(v)) v = 38;
        v = Math.max(18, Math.min(72, Math.round(v)));
        if(lobsterSize) lobsterSize.value = String(v);
        applyLobsterSize();
        if(lobsterSize) lobsterSize.addEventListener('input', applyLobsterSize);
        if(lobsterSize) lobsterSize.addEventListener('change', applyLobsterSize);
      })();


      (function initRegionsDebug(){
        let on = false;
        try{ on = localStorage.getItem('lobsterRoom.showRegions') === '1'; }catch{}
        if(toggleRegions) toggleRegions.checked = on;
        document.getElementById('room').classList.toggle('show-regions', on);
        if(toggleRegions){
          toggleRegions.addEventListener('change', ()=>{
            const v = !!toggleRegions.checked;
            const room = document.getElementById('room');
            room.classList.toggle('show-regions', v);
            // When showing zones debug, also show tile overlay (which we now use to render saved/manual zones shapes).
            room.classList.toggle('show-tiles', v);
            try{ localStorage.setItem('lobsterRoom.showRegions', v?'1':'0'); }catch{}
            renderRegions();
          });
        }

        // (Removed) tile overlay / auto inference buttons for now; focus on manual Room Editor.
      })();

      // Move Debug panel visibility (default off)
      (function initMoveDebugVisibility(){
        mvLoadPrefs();
        if(toggleMvdbg) toggleMvdbg.checked = !!MVDBG.visible;
        mvRenderPanel();
        if(toggleMvdbg){
          toggleMvdbg.addEventListener('change', ()=>{
            MVDBG.visible = !!toggleMvdbg.checked;
            // If panel is hidden, also disable logging/overlay by default to reduce clutter.
            if(!MVDBG.visible){
              MVDBG.enabled = false;
              MVDBG.overlayOn = false;
            }
            mvSavePrefs();
            mvRenderPanel();
            mvRenderOverlay();
          });
        }
      })();

      // Agent detail toggle (default on)
      (function initAgentDetailToggle(){
        let on = true;
        try{ const s = localStorage.getItem('lobsterRoom.showAgentDetail'); if(s!==null) on = (s==='1'); }catch{}
        if(toggleAgentDetail) toggleAgentDetail.checked = !!on;
        MODEL.showAgentDetail = !!on;
        if(toggleAgentDetail){
          toggleAgentDetail.addEventListener('change', ()=>{
            const v = !!toggleAgentDetail.checked;
            MODEL.showAgentDetail = v;
            try{ localStorage.setItem('lobsterRoom.showAgentDetail', v?'1':'0'); }catch{}
            // re-render to update current nodes
            try{ renderAgents(); }catch{}
          });
        }
      })();

      // Agent labels mapping (modal UI)
      (function initAgentLabels(){
        const openLabels = ()=>{ if(labelsBackdrop) labelsBackdrop.classList.add('show'); };
        const closeLabels = ()=>{ if(labelsBackdrop) labelsBackdrop.classList.remove('show'); };

        const makeRow = (agentId, label)=>{
          const row = document.createElement('div');
          row.className = 'row';
          row.style.gap = '10px';
          row.style.alignItems = 'center';
          row.innerHTML = `
            <div class="hint" style="min-width:120px">${agentId ? agentId : '<new agentId>'}</div>
            <input class="grow" data-k="k" placeholder="agentId" value="${agentId||''}" style="background:#0f1115;border:1px solid rgba(255,255,255,.10);color:var(--text);padding:10px 12px;border-radius:10px" />
            <input class="grow" data-k="v" placeholder="Display name (optional)" value="${label||''}" style="background:#0f1115;border:1px solid rgba(255,255,255,.10);color:var(--text);padding:10px 12px;border-radius:10px" />
            <button class="btn" type="button" data-k="del">Remove</button>
          `;
          row.querySelector('[data-k=del]').addEventListener('click', ()=>{ try{ row.remove(); }catch{} });
          return row;
        };

        const loadIntoModal = async ()=>{
          if(!labelsList) return;
          if(labelsStatus) labelsStatus.textContent = 'Loading…';
          labelsList.innerHTML = '';
          try{
            // Get known agentIds from the live API.
            const r0 = await fetch('./api/lobster-room?ts=' + Date.now(), {cache:'no-store'});
            const j0 = r0.ok ? await r0.json() : null;
            const agentIds = new Set();
            if(j0 && Array.isArray(j0.agents)){
              for(const a of j0.agents){
                const id = String(a && a.id || '');
                const m = id.match(/^resident@(.+)$/);
                agentIds.add(m ? m[1] : id);
              }
            }

            // Get existing mapping.
            const r = await fetch('./api/agent-labels?ts=' + Date.now(), {cache:'no-store'});
            const j = r.ok ? await r.json() : null;
            const labels = (j && j.ok && j.labels && typeof j.labels === 'object') ? j.labels : {};

            // Render rows: all known agentIds first.
            for(const id of Array.from(agentIds).sort()){
              labelsList.appendChild(makeRow(id, labels[id]||''));
            }
            // Render any extra keys not in agentIds.
            for(const [k,v] of Object.entries(labels)){
              if(agentIds.has(k)) continue;
              labelsList.appendChild(makeRow(k, v));
            }
            if(labelsStatus) labelsStatus.textContent = '';
          }catch{
            if(labelsStatus) labelsStatus.textContent = 'Load failed.';
          }
        };

        const collectMapping = ()=>{
          const out = {};
          if(!labelsList) return out;
          const rows = Array.from(labelsList.children);
          for(const row of rows){
            const k = (row.querySelector('input[data-k=k]')?.value || '').trim();
            const v = (row.querySelector('input[data-k=v]')?.value || '').trim();
            if(!k) continue;
            if(v) out[k] = v;
          }
          return out;
        };

        if(btnAgentLabelsOpen){
          btnAgentLabelsOpen.addEventListener('click', async ()=>{
            openLabels();
            await loadIntoModal();
          });
        }
        if(btnLabelsClose) btnLabelsClose.addEventListener('click', closeLabels);
        if(labelsBackdrop) labelsBackdrop.addEventListener('click', (e)=>{ if(e.target===labelsBackdrop) closeLabels(); });

        if(btnLabelsAdd) btnLabelsAdd.addEventListener('click', ()=>{ if(labelsList) labelsList.appendChild(makeRow('', '')); });

        if(btnLabelsSave) btnLabelsSave.addEventListener('click', async ()=>{
          const obj = collectMapping();
          if(agentLabelsStatus) agentLabelsStatus.textContent = 'Saving…';
          if(labelsStatus) labelsStatus.textContent = 'Saving…';
          try{
            const r = await fetch('./api/agent-labels', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({labels: obj})});
            const j = r.ok ? await r.json() : null;
            if(!j || !j.ok) throw new Error('save_failed');
            if(agentLabelsStatus) agentLabelsStatus.textContent = 'Saved.';
            if(labelsStatus) labelsStatus.textContent = 'Saved.';
            // Re-render using server normalized form.
            if(labelsList){
              labelsList.innerHTML='';
              for(const [k,v] of Object.entries(j.labels||obj)) labelsList.appendChild(makeRow(k,v));
            }
          }catch{
            if(agentLabelsStatus) agentLabelsStatus.textContent = 'Save failed.';
            if(labelsStatus) labelsStatus.textContent = 'Save failed.';
          }
        });
      })();

      async function loadManualMapFromServer(){
        try{
          const r = await fetch('./api/manual-map?ts=' + Date.now(), {cache:'no-store'});
          if(!r.ok) return false;
          const mm = await r.json();
          if(mm && mm.tx && mm.ty && Array.isArray(mm.cells)){
            MODEL.manualMap = mm;
            try{ localStorage.setItem('lobsterRoom.manualMap', JSON.stringify(mm)); }catch{}
            return true;
          }
        }catch{}
        return false;
      }

      // Load saved manual room map (prefer server, fallback to localStorage)
      (async ()=>{
        const ok = await loadManualMapFromServer();
        if(!ok){
          try{ MODEL.manualMap = JSON.parse(localStorage.getItem('lobsterRoom.manualMap') || 'null'); }catch{}
        }
        // Mark ready only after we attempted all sources.
        MODEL.manualReady = true;
      })();

      function initEditorState(){
        const TX=32, TY=20;
        if(!MODEL.manualMap || MODEL.manualMap.tx!==TX || MODEL.manualMap.ty!==TY || !Array.isArray(MODEL.manualMap.cells)){
          MODEL.manualMap = { version:1, tx:TX, ty:TY, cells: new Array(TX*TY).fill(null), updatedAt: null };
        }
      }

      const BRUSH_COLORS = {
        work: 'rgba(99,102,241,0.45)',
        tools: 'rgba(147,51,234,0.42)',
        lounge: 'rgba(250,204,21,0.36)',
        meeting: 'rgba(248,113,113,0.36)',
        corridor: 'rgba(34,211,238,0.40)',
        blocked: 'rgba(0,0,0,0.45)',
      };

      function setActiveButton(groupEl, attr, value){
        if(!groupEl) return;
        groupEl.querySelectorAll('button['+attr+']').forEach(b=>b.classList.toggle('active', b.getAttribute(attr)===value));
      }

      function paintCell(tx, ty, brush){
        const mm = MODEL.manualMap;
        if(!mm) return;
        if(tx<0||ty<0||tx>=mm.tx||ty>=mm.ty) return;
        const idx = ty*mm.tx + tx;
        if(brush==='erase') mm.cells[idx]=null;
        else if(brush==='blocked') mm.cells[idx]='blocked';
        else if(['work','tools','lounge','meeting','corridor'].includes(brush)) mm.cells[idx]=brush;
      }

      function renderEditor(){
        if(!editorCanvas) return;
        initEditorState();
        const mm = MODEL.manualMap;
        const ctx = editorCanvas.getContext('2d');
        const w = editorCanvas.width, h = editorCanvas.height;
        ctx.clearRect(0,0,w,h);

        // background: show uploaded room image faintly if available
        const bg = document.getElementById('room-bg');
        if(bg && bg.complete && bg.naturalWidth){
          ctx.globalAlpha = 0.35;
          ctx.drawImage(bg, 0, 0, w, h);
          ctx.globalAlpha = 1;
        }

        const cw = w / mm.tx;
        const ch = h / mm.ty;

        // painted cells
        for(let i=0;i<mm.cells.length;i++){
          const t = mm.cells[i];
          if(!t) continue;
          const x = i % mm.tx;
          const y = Math.floor(i / mm.tx);
          ctx.fillStyle = BRUSH_COLORS[t] || 'rgba(255,255,255,0.08)';
          ctx.fillRect(x*cw, y*ch, cw, ch);
        }

        // grid
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth = 1;
        for(let x=0;x<=mm.tx;x++){
          ctx.beginPath();
          ctx.moveTo(x*cw, 0);
          ctx.lineTo(x*cw, h);
          ctx.stroke();
        }
        for(let y=0;y<=mm.ty;y++){
          ctx.beginPath();
          ctx.moveTo(0, y*ch);
          ctx.lineTo(w, y*ch);
          ctx.stroke();
        }

        if(editorStatus){
          const used = mm.cells.filter(Boolean).length;
          editorStatus.textContent = `painted: ${used}/${mm.cells.length}`;
        }
      }

      (function bindEditor(){
        if(!editorCanvas) return;
        initEditorState();

        let brush = 'work';
        let size = 1;
        setActiveButton(brushSeg, 'data-brush', brush);
        setActiveButton(sizeSeg, 'data-size', String(size));

        if(brushSeg){
          brushSeg.addEventListener('click', (e)=>{
            const b = e.target && e.target.closest('button[data-brush]');
            if(!b) return;
            brush = b.getAttribute('data-brush');
            setActiveButton(brushSeg, 'data-brush', brush);
          });
        }
        if(sizeSeg){
          sizeSeg.addEventListener('click', (e)=>{
            const b = e.target && e.target.closest('button[data-size]');
            if(!b) return;
            size = parseInt(b.getAttribute('data-size')||'1',10) || 1;
            setActiveButton(sizeSeg, 'data-size', String(size));
          });
        }

        function posToCell(ev){
          const mm = MODEL.manualMap;
          const r = editorCanvas.getBoundingClientRect();
          const x = (ev.clientX - r.left) / r.width;
          const y = (ev.clientY - r.top) / r.height;
          return { tx: Math.floor(x * mm.tx), ty: Math.floor(y * mm.ty) };
        }

        function paintAt(ev){
          const mm = MODEL.manualMap;
          const p = posToCell(ev);
          const rad = Math.max(0, size-1);
          for(let dy=-rad;dy<=rad;dy++) for(let dx=-rad;dx<=rad;dx++){
            paintCell(p.tx+dx, p.ty+dy, brush);
          }
          renderEditor();
        }

        let down=false;
        editorCanvas.addEventListener('pointerdown', (e)=>{ down=true; editorCanvas.setPointerCapture(e.pointerId); paintAt(e); });
        editorCanvas.addEventListener('pointermove', (e)=>{ if(down) paintAt(e); });
        editorCanvas.addEventListener('pointerup', ()=>{ down=false; });
        editorCanvas.addEventListener('pointercancel', ()=>{ down=false; });

        if(btnClearEditor){
          btnClearEditor.addEventListener('click', ()=>{
            initEditorState();
            MODEL.manualMap.cells.fill(null);
            MODEL.manualMap.updatedAt = Date.now();
            renderEditor();
          });
        }

        // (Removed) Initialize-from-inference for now (confusing & may overwrite user's work)

        if(btnSaveEditor){
          btnSaveEditor.addEventListener('click', async ()=>{
            initEditorState();
            MODEL.manualMap.updatedAt = Date.now();
            try{ localStorage.setItem('lobsterRoom.manualMap', JSON.stringify(MODEL.manualMap)); }catch{}
            // Persist to server so all browsers/profiles see the same walkable map.
            try{
              const r = await fetch('./api/manual-map', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(MODEL.manualMap)});
              if(!r.ok) throw new Error('HTTP ' + r.status);
              const j = await r.json().catch(()=>null);
              if(!j || !j.ok) throw new Error('save_failed');
            }catch(e){
              console.warn('[lobster-room] manual-map server save failed; kept localStorage only', e);
            }
            if(editorStatus) editorStatus.textContent = 'Saved.';
            renderRegions();
          });
        }

        renderEditor();
      })();

      btnUpload.addEventListener('click', async ()=>{
        const f = fileInput.files && fileInput.files[0];
        if(!f){ statusEl.textContent = 'Choose an image first.'; return; }
        if(f.size > 8*1024*1024){ statusEl.textContent = 'File too large (max 8MB).'; return; }

        // Aspect ratio guard: require landscape-ish images.
        // This room view expects wide backgrounds; portrait images look odd.
        try{
          const bmp = await createImageBitmap(f);
          const w = bmp.width || 0;
          const h = bmp.height || 0;
          bmp.close && bmp.close();
          if(w>0 && h>0){
            const ratio = w / h;
            if(ratio < 1.15){
              statusEl.textContent = `Upload rejected: image is too portrait (w/h=${ratio.toFixed(2)}). Please use a wider image.`;
              return;
            }
          }
        }catch{}

        statusEl.textContent = 'Uploading…';
        const fd = new FormData();
        fd.append('file', f, f.name);
        try{
          const r = await fetch('./api/room-image', {method:'POST', body: fd});
          if(!r.ok){ statusEl.textContent = 'Upload failed (HTTP ' + r.status + ')'; return; }
          const j = await r.json().catch(()=>null);
          if(!j || !j.ok){ statusEl.textContent = 'Upload failed.'; return; }
          // New room created & active; load its blank manual map.
          MODEL.manualReady = false;
          await loadManualMapFromServer();
          MODEL.manualReady = true;
          await refreshRoomsList();
          await refreshRoomBg();

          // Stay in Settings after upload so user can paint the manual map right away.
          try{
            statusEl.textContent = 'Upload complete. Next: paint the walkable manual map below, then click Save.';
          }catch{}
          try{
            renderEditor();
            const ed = document.getElementById('room-editor');
            if(ed && ed.scrollIntoView) ed.scrollIntoView({behavior:'smooth', block:'start'});
          }catch{}
        }catch(e){
          statusEl.textContent = 'Upload failed: ' + (e && e.message ? e.message : 'network error');
        }
      });

      btnReset.addEventListener('click', async ()=>{
        if(!confirm('Switch to Default room?')) return;
        statusEl.textContent = 'Switching…';
        const r = await fetch('./api/room-image/reset', {method:'POST'});
        if(!r.ok){ statusEl.textContent = 'Switch failed (HTTP ' + r.status + ')'; return; }
        MODEL.manualReady = false;
        await loadManualMapFromServer();
        MODEL.manualReady = true;
        await refreshRoomsList();
        await refreshRoomBg();
      });

      if(btnDeleteRoom){
        btnDeleteRoom.addEventListener('click', async ()=>{
          const cur = roomSelect ? roomSelect.value : '';
          if(!cur || cur==='default') return;
          if(!confirm('Delete this room? (Default cannot be deleted)')) return;
          statusEl.textContent = 'Deleting…';
          try{
            const j = await apiPostJson('./api/rooms/delete', {roomId: cur});
            if(!j || j.ok!==true){ throw new Error('delete_failed'); }
          }catch(e){
            statusEl.textContent = 'Delete failed.';
            return;
          }
          MODEL.manualReady = false;
          await loadManualMapFromServer();
          MODEL.manualReady = true;
          await refreshRoomsList();
          await refreshRoomBg();
        });
      }

      if(roomSelect){
        roomSelect.addEventListener('change', async ()=>{
          const id = roomSelect.value;
          try{
            await apiPostJson('./api/rooms/active', {roomId:id});
          }catch{}
          MODEL.manualReady = false;
          await loadManualMapFromServer();
          MODEL.manualReady = true;
          await refreshRoomsList();
          await refreshRoomBg();
          renderRegions();
          renderEditor();
        });
      }

      refreshRoomBg();
      refreshRoomsList();
      // When using manual map, show debug overlay reflects saved zones.
      setTimeout(()=>{ renderRegions(); renderEditor(); }, 100);
    }

    init();
