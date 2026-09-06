/* GPS controller for the unified Jornada screen. */
(() => {
  'use strict';
  let watch = null, lastSent = 0, sending = false, changing = false;
  let active = null, signal = '', generation = 0;
  const stopKey = () => `avanza-tracking-stop:${me.id}`;
  const pendingStop = () => Boolean(localStorage.getItem(stopKey()));
  const notify = () => window.dispatchEvent(new Event('journey-signal'));
  const stopWatch = () => { if (watch !== null) navigator.geolocation?.clearWatch(watch); watch = null; generation++; };
  async function call(path, data) {
    const r = await fetch('/api/tracking/'+path, { ...(data ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)} : {}), signal:AbortSignal.timeout(12000) });
    const d = await r.json(); if(!r.ok) throw Object.assign(new Error(d.error), {status:r.status}); return d;
  }
  function startWatch() {
    if(watch !== null || !navigator.geolocation || pendingStop())return;
    lastSent = 0;
    watch = navigator.geolocation.watchPosition(async p => {
      if(sending || Date.now()-lastSent<15000 || pendingStop())return;
      sending=true; const epoch=generation;
      try {
        const {latitude,longitude,accuracy}=p.coords;
        await call('location',{latitude,longitude,accuracy}); lastSent=Date.now();
        if(epoch===generation)signal=`GPS enviado ${new Date().toLocaleTimeString('es')} · precisión ±${Math.round(accuracy)} m`;
      } catch(error) {
        if(epoch===generation)signal=error.status?error.message:'Sin señal: el recorrido GPS puede tener intervalos sin registrar.';
        if(error.status===401||error.status===403||error.status===409){stopWatch();active=null;}
      } finally { sending=false;notify(); }
    }, e => { signal=e.code===1?'Permiso GPS denegado. Habilítalo para compartir ubicación.':'No se pudo obtener el GPS. Revisa la ubicación del celular.';notify(); },{enableHighAccuracy:true,maximumAge:10000,timeout:20000});
  }
  async function flushStop() {
    if(!pendingStop())return;
    stopWatch();await call('stop',{});localStorage.removeItem(stopKey());active=false;
    signal='Jornada finalizada. GPS detenido.';notify();
  }
  async function load(userId) {
    let person=null;
    if(me.role==='seller') {
      await flushStop();
      const epoch=generation, status=await call('status');
      if(!changing&&epoch===generation){active=status.active;if(active)startWatch();else stopWatch();}
      person={user:me,...status};
    } else {
      const {people}=await call('team');person=people.find(p=>p.user.id===userId)||null;
    }
    const {points}=await call('history?userId='+encodeURIComponent(userId));
    return {person,points,loadedAt:new Date().toISOString()};
  }
  async function toggle() {
    if(changing || me.role!=='seller')return;
    changing=true;notify();
    try {
      if(active || pendingStop()) {
        localStorage.setItem(stopKey(),'1');stopWatch();active=false;
        signal='GPS detenido; enviando cierre de jornada…';notify();await flushStop();
      } else {
        if(!navigator.geolocation)throw new Error('Este dispositivo no ofrece GPS');
        await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,()=>reject(new Error('Autoriza la ubicación para iniciar la jornada')),{enableHighAccuracy:true,timeout:15000,maximumAge:0}));
        await call('start',{});active=true;signal='Jornada activa. Mantén Avanza abierta para compartir ubicación.';startWatch();
      }
    } catch(error) {signal=pendingStop()?'GPS detenido. Cierre pendiente de sincronizar; se reintentará al recuperar conexión.':error.message;}
    finally {changing=false;notify();window.refreshJourney?.();}
  }
  window.journeyTracking={load,toggle,state:()=>({active,signal,changing,pendingStop:me?.role==='seller'&&pendingStop()})};
  window.addEventListener('online',()=>{if(me?.role==='seller')window.refreshJourney?.();});
})();
