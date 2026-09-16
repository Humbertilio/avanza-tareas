package com.avanza.vendedores;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.location.*;
import android.os.*;
import org.json.*;

public final class TrackingService extends Service implements LocationListener {
    static final long INTERVAL=300000L;
    static volatile boolean running=false;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private LocationManager manager;
    private PowerManager.WakeLock wake;
    private Store store;
    private Location best;
    private boolean sampling=false,started=false;
    private long next;
    public IBinder onBind(Intent i){return null;}
    private Notification notice(){
        Intent open=new Intent(this,MainActivity.class);
        PendingIntent pending=PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this,"journey").setSmallIcon(com.avanza.vendedores.R.drawable.ic_avanza).setContentTitle("Avanza · Jornada activa")
            .setContentText("GPS cada 5 minutos · "+store.count()+" registros pendientes").setOngoing(true).setContentIntent(pending).setOnlyAlertOnce(true).build();
    }
    public void onCreate(){super.onCreate();store=Store.get(this);manager=(LocationManager)getSystemService(LOCATION_SERVICE);getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("journey","Jornada y ubicación",NotificationManager.IMPORTANCE_LOW));}
    public int onStartCommand(Intent intent,int flags,int id){
        if(checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)!=PackageManager.PERMISSION_GRANTED){store.value("gpsMessage","Permita ubicación precisa y vuelva a abrir Avanza.");stopSelf();return START_NOT_STICKY;}
        try{
            startForeground(5,notice());
            if(!store.active()){if(intent==null||!"START".equals(intent.getAction())){stopSelf();return START_NOT_STICKY;}store.start();}
            if(!started){started=true;running=true;wake=((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"Avanza:Journey");wake.setReferenceCounted(false);wake.acquire(600000L);
                String last=store.value("lastCapture");long wait=last.isEmpty()?0:Math.max(0,INTERVAL-(System.currentTimeMillis()-java.time.Instant.parse(last).toEpochMilli()));next=SystemClock.elapsedRealtime()+wait;handler.postDelayed(sample,wait);handler.post(sync);}
        }catch(Exception e){store.value("gpsMessage","No se pudo activar el servicio GPS. Abra Avanza y revise los permisos.");stopSelf();return START_NOT_STICKY;}
        return START_STICKY;
    }
    private final Runnable sample=new Runnable(){public void run(){
        if(!store.active()){stopSelf();return;}
        if(!store.value("startConfirmed").equals("1")){store.value("gpsMessage","Esperando confirmación de inicio del servidor");handler.postDelayed(this,1000);return;}
        next+=INTERVAL;long now=SystemClock.elapsedRealtime();if(next<=now)next=now+INTERVAL;
        beginSample();handler.postDelayed(this,Math.max(1,next-SystemClock.elapsedRealtime()));
    }};
    private final Runnable sync=new Runnable(){public void run(){
        if(!store.active()){stopSelf();return;}if(wake!=null)wake.acquire(600000L);Api.IO.execute(()->{Api.sync(TrackingService.this);handler.post(()->{if(running)getSystemService(NotificationManager.class).notify(5,notice());});});handler.postDelayed(this,60000);
    }};
    private void beginSample(){
        manager.removeUpdates(this);best=null;sampling=true;store.value("gpsMessage","Buscando ubicación…");
        try{
            boolean enabled=false;
            for(String provider:new String[]{LocationManager.GPS_PROVIDER,LocationManager.NETWORK_PROVIDER})if(manager.isProviderEnabled(provider)){manager.requestLocationUpdates(provider,0,0,this,Looper.getMainLooper());enabled=true;}
            if(!enabled){sampling=false;store.value("gpsMessage","Ubicación desactivada. Active el GPS del teléfono.");return;}
            handler.postDelayed(finishSample,60000);
        }catch(SecurityException e){sampling=false;store.value("gpsMessage","Permiso GPS retirado. Abra Avanza para reanudar.");stopSelf();}
    }
    public void onLocationChanged(Location location){
        if(!sampling||!store.active()||!location.hasAccuracy()||SystemClock.elapsedRealtimeNanos()-location.getElapsedRealtimeNanos()>30000000000L)return;
        if(location.getTime()<java.time.Instant.parse(store.value("startedAt")).toEpochMilli())return;
        if(best==null||location.getAccuracy()<best.getAccuracy())best=location;
        if(best.getAccuracy()<=50)finishSample.run();
    }
    private final Runnable finishSample=()->{
        handler.removeCallbacks(finishSampleCallback());manager.removeUpdates(this);if(!sampling)return;sampling=false;
        if(!store.active())return;
        if(best==null){store.value("gpsMessage","Sin señal GPS en esta toma. Se intentará en el siguiente intervalo.");return;}
        try{
            String at=java.time.Instant.ofEpochMilli(best.getTime()).toString();
            JSONObject e=store.event("point",store.value("session"),at).put("latitude",best.getLatitude()).put("longitude",best.getLongitude()).put("accuracy",best.getAccuracy());
            store.enqueue(e);store.value("lastCapture",at);store.value("gpsMessage","GPS guardado · precisión ±"+Math.round(best.getAccuracy())+" m");
            Api.IO.execute(()->Api.sync(TrackingService.this));
        }catch(Exception e){store.value("gpsMessage","No se pudo guardar el GPS: "+e.getMessage());}
    };
    private Runnable finishSampleCallback(){return finishSample;}
    public void onProviderEnabled(String p){}
    public void onProviderDisabled(String p){store.value("gpsMessage","GPS desactivado o sin señal");}
    public void onStatusChanged(String provider,int status,Bundle extras){}
    public void onDestroy(){running=false;handler.removeCallbacksAndMessages(null);if(manager!=null)manager.removeUpdates(this);if(wake!=null&&wake.isHeld())wake.release();if(store!=null){if(store.active())store.value("gpsMessage","Seguimiento interrumpido. Abra Avanza y pulse Reanudar GPS.");SyncJob.schedule(this);}stopForeground(STOP_FOREGROUND_REMOVE);super.onDestroy();}
}
