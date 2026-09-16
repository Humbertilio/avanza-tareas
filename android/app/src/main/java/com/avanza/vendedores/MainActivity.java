package com.avanza.vendedores;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.widget.*;
import org.json.*;

public final class MainActivity extends Activity {
    private Store store;private LinearLayout column;private TextView status;private Button start,stop,logout;private volatile boolean busy=false;private final Handler handler=new Handler(Looper.getMainLooper());
    private final Runnable refresh=new Runnable(){public void run(){renderStatus();handler.postDelayed(this,2000);}};
    public void onCreate(Bundle state){super.onCreate(state);store=Store.get(this);getWindow().getDecorView().setOnApplyWindowInsetsListener((view,insets)->{view.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets;});show();}
    public void onResume(){super.onResume();handler.post(refresh);Api.IO.execute(()->{Api.sync(this);runOnUiThread(()->{if(store.value("authRequired").equals("1"))show();});});}
    public void onPause(){handler.removeCallbacks(refresh);super.onPause();}
    private TextView text(String value,int size){TextView v=new TextView(this);v.setText(value);v.setTextSize(size);v.setTextColor(Color.rgb(36,54,80));v.setPadding(0,12,0,12);column.addView(v);return v;}
    private Button button(String label,Runnable action){Button b=new Button(this);b.setText(label);b.setAllCaps(false);column.addView(b,new LinearLayout.LayoutParams(-1,-2));b.setOnClickListener(v->action.run());return b;}
    private EditText input(String hint,boolean password){EditText e=new EditText(this);e.setHint(hint);e.setSingleLine(true);e.setInputType(password?129:1);column.addView(e);return e;}
    private void show(){
        status=null;start=null;stop=null;logout=null;ScrollView scroll=new ScrollView(this);column=new LinearLayout(this);column.setOrientation(LinearLayout.VERTICAL);int pad=(int)(20*getResources().getDisplayMetrics().density);column.setPadding(pad,pad,pad,pad);scroll.addView(column);setContentView(scroll);text("Avanza Vendedores",26);
        boolean authenticated=false;try{authenticated=!store.token().isEmpty()&&!store.value("authRequired").equals("1");}catch(Exception e){store.clearToken();}
        if(!authenticated){
            text("Inicie sesión con su cuenta de vendedor. La ubicación se registra únicamente durante una jornada iniciada por usted.",16);
            if(store.count()>0)text("Hay "+store.count()+" registros guardados. Inicie sesión con la misma cuenta para enviarlos.",15);
            EditText user=input("Usuario",false),password=input("Contraseña",true);user.setText(store.prefs.getString("username",""));
            button("Ingresar",()->{if(busy)return;busy=true;String name=user.getText().toString(),pass=password.getText().toString();Api.IO.execute(()->{try{JSONObject result=Api.request(this,"login",new JSONObject().put("username",name).put("password",pass).put("deviceId",store.device()));JSONObject who=result.getJSONObject("user");String old=store.value("userId");if((store.active()||store.count()>0)&&!old.isEmpty()&&!old.equals(who.getString("id")))throw new Exception("Hay registros pendientes de otra cuenta. Use la cuenta anterior.");store.token(result.getString("token"));store.value("userId",who.getString("id"));store.value("name",who.getString("name"));store.value("authRequired","0");store.prefs.edit().putString("username",name).commit();Api.sync(this);runOnUiThread(this::show);}catch(Exception e){error(e.getMessage());}finally{busy=false;}});});return;
        }
        text(store.value("name"),20);
        text("Durante la jornada, el teléfono intenta registrar una ubicación cada 5 minutos, incluso con la pantalla bloqueada. Sin internet, guarda los puntos para enviarlos después. Puede haber retrasos si Android limita la app o no hay señal GPS.",15);
        status=text("",16);start=button("Iniciar jornada",this::begin);stop=button("Finalizar jornada",this::finishJourney);

        button("Abrir Avanza",()->startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(Api.BASE+"/#visits"))));
        button("Ajustes de batería y permisos",()->startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName()))));
        text("Si Android interrumpe el seguimiento o reinicia el teléfono, abra esta aplicación y pulse Reanudar GPS. No fuerce su cierre durante la jornada. En los ajustes de la aplicación permita el uso de batería sin restricciones.",14);
        logout=button("Cerrar sesión",()->{if(store.active()||store.count()>0){error("Finalice la jornada y sincronice los registros antes de cerrar sesión.");return;}Api.IO.execute(()->{try{Api.request(this,"logout",new JSONObject());store.clearToken();runOnUiThread(this::show);}catch(Exception e){error(e.getMessage());}});});renderStatus();
    }
    private void renderStatus(){if(status==null)return;boolean active=store.active();status.setText((active?TrackingService.running?"Jornada activa":"Jornada pendiente de reanudar":"Jornada detenida")+"\nÚltima captura: "+localTime(store.value("lastCapture"))+"\n"+store.value("gpsMessage")+"\nPendientes: "+store.count()+"\n"+store.value("syncMessage"));start.setText(active?"Reanudar GPS":"Iniciar jornada");start.setEnabled(!busy&&!TrackingService.running&&(active||store.count()==0));stop.setEnabled(active&&!busy);}
    private String localTime(String value){try{return java.time.Instant.parse(value).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("dd/MM HH:mm:ss"));}catch(Exception e){return "Sin captura";}}
    private void begin(){
        if(busy)return;
        if(checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)!=PackageManager.PERMISSION_GRANTED){requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,Manifest.permission.ACCESS_COARSE_LOCATION},10);return;}
        if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED){requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},11);return;}
        android.location.LocationManager lm=(android.location.LocationManager)getSystemService(LOCATION_SERVICE);if(!lm.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER)){error("Active la ubicación del teléfono antes de iniciar la jornada.");startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));return;}
        if(store.active()){startForegroundService(new Intent(this,TrackingService.class));return;}
        // Starting a new shift requires an online role/session check; existing shifts continue offline.
        busy=true;renderStatus();Api.IO.execute(()->{try{JSONObject data=Api.request(this,"status",null);if(!data.isNull("session"))throw new Exception("Tiene una jornada abierta en Avanza u otro dispositivo. Finalícela antes de iniciar aquí.");runOnUiThread(()->{if(isFinishing()||!hasWindowFocus()){error("Mantenga Avanza abierta para iniciar la jornada.");return;}try{startForegroundService(new Intent(this,TrackingService.class).setAction("START"));}catch(Exception e){error("No se pudo iniciar: "+e.getMessage());}});}catch(Exception e){if(e instanceof Api.Failure && ((Api.Failure)e).status==401){store.value("authRequired","1");runOnUiThread(this::show);}error(e.getMessage());}finally{busy=false;runOnUiThread(this::renderStatus);}});
    }
    public void onRequestPermissionsResult(int code,String[] permissions,int[] grants){super.onRequestPermissionsResult(code,permissions,grants);if(grants.length>0&&grants[0]==PackageManager.PERMISSION_GRANTED)begin();else error("Se necesitan ubicación precisa y notificaciones para registrar una jornada visible.");}
    private void finishJourney(){try{store.stop();stopService(new Intent(this,TrackingService.class));renderStatus();Api.IO.execute(()->{Api.sync(this);SyncJob.schedule(this);runOnUiThread(this::renderStatus);});}catch(Exception e){error(e.getMessage());}}
    private void error(String message){runOnUiThread(()->new AlertDialog.Builder(this).setTitle("Avanza").setMessage(message).setPositiveButton("Aceptar",null).show());}
}
