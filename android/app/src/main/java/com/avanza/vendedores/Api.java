package com.avanza.vendedores;
import android.content.Context;
import org.json.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
final class Api {
    static final String BASE="https://avanza-tareas.onrender.com";
    static final java.util.concurrent.ExecutorService IO=java.util.concurrent.Executors.newSingleThreadExecutor();
    static class Failure extends IOException{final int status;Failure(int s,String text){super(text);status=s;}}
    static JSONObject request(Context c,String route,JSONObject body)throws Exception{
        HttpURLConnection conn=(HttpURLConnection)new URL(BASE+"/api/mobile/"+route).openConnection();conn.setConnectTimeout(15000);conn.setReadTimeout(20000);conn.setInstanceFollowRedirects(false);
        if(!route.equals("login"))conn.setRequestProperty("Authorization","Bearer "+Store.get(c).token());
        try{if(body!=null){conn.setRequestMethod("POST");conn.setDoOutput(true);conn.setRequestProperty("Content-Type","application/json");try(OutputStream out=conn.getOutputStream()){out.write(body.toString().getBytes(StandardCharsets.UTF_8));}}
            int status=conn.getResponseCode();InputStream stream=status<400?conn.getInputStream():conn.getErrorStream();if(stream==null)throw new Failure(status,"Servidor no disponible");String text;try(InputStream in=stream){ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] chunk=new byte[4096];int n;while((n=in.read(chunk))!=-1)bytes.write(chunk,0,n);text=new String(bytes.toByteArray(),StandardCharsets.UTF_8);}JSONObject result;try{result=new JSONObject(text);}catch(JSONException e){throw new Failure(status,"Respuesta inválida del servidor");}if(status>=300)throw new Failure(status,result.optString("error","No se pudo conectar"));return result;
        }finally{conn.disconnect();}
    }
    static boolean sync(Context c){Store s=Store.get(c);try{if(s.token().isEmpty()||s.value("authRequired").equals("1"))return false;while(s.count()>0){JSONArray batch=s.batch();JSONObject result=request(c,"sync",new JSONObject().put("events",batch));JSONArray ack=result.getJSONArray("accepted");if(ack.length()==0)throw new IOException("Servidor sin confirmación");s.ack(ack);}s.value("syncMessage","Todo sincronizado");s.value("lastSync",Store.now());return true;
        }catch(Exception e){s.value("syncMessage",e instanceof Failure?e.getMessage():"Sin conexión. Los puntos están guardados en el teléfono.");if(e instanceof Failure&&((Failure)e).status==409&&s.value("startConfirmed").equals("0")){s.rejectUnconfirmedStart();c.stopService(new android.content.Intent(c,TrackingService.class));}if(e instanceof Failure&&(((Failure)e).status==401||((Failure)e).status==403)){s.value("authRequired","1");try{s.stop();}catch(Exception ignored){}c.stopService(new android.content.Intent(c,TrackingService.class));}return false;}}
}
