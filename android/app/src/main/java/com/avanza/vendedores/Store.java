package com.avanza.vendedores;

import android.content.*;
import android.database.Cursor;
import android.database.sqlite.*;
import android.security.keystore.*;
import android.util.Base64;
import org.json.*;
import java.security.KeyStore;
import java.util.UUID;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;

final class Store extends SQLiteOpenHelper {
    private static Store instance;
    final android.content.SharedPreferences prefs;
    static synchronized Store get(Context c) { if(instance==null)instance=new Store(c.getApplicationContext());return instance; }
    private Store(Context c){super(c,"gps.db",null,1);prefs=c.getSharedPreferences("avanza",Context.MODE_PRIVATE);}
    public void onCreate(SQLiteDatabase db){db.execSQL("CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)");db.execSQL("CREATE TABLE state(key TEXT PRIMARY KEY, value TEXT)");}
    public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion){}
    synchronized String value(String key){try(Cursor c=getReadableDatabase().rawQuery("SELECT value FROM state WHERE key=?",new String[]{key})){return c.moveToFirst()?c.getString(0):"";}}
    synchronized void value(String key,String value){ContentValues v=new ContentValues();v.put("key",key);v.put("value",value);getWritableDatabase().insertWithOnConflict("state",null,v,SQLiteDatabase.CONFLICT_REPLACE);}
    String device(){String id=prefs.getString("device","");if(id.isEmpty()){id=UUID.randomUUID().toString();prefs.edit().putString("device",id).commit();}return id;}
    boolean active(){return value("active").equals("1");}
    static String now(){return java.time.Instant.now().toString();}
    synchronized JSONObject event(String type,String session,String at)throws JSONException{return new JSONObject().put("id",UUID.randomUUID().toString()).put("sessionId",session).put("type",type).put("recordedAt",at);}
    synchronized void enqueue(JSONObject event){ContentValues v=new ContentValues();v.put("id",event.optString("id"));v.put("payload",event.toString());getWritableDatabase().insertOrThrow("events",null,v);}
    synchronized void start()throws Exception{
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{if(active())return;String id=UUID.randomUUID().toString();enqueue(event("start",id,now()));value("session",id);value("active","1");value("startConfirmed","0");value("lastCapture","");value("startedAt",now());db.setTransactionSuccessful();}finally{db.endTransaction();}
    }
    synchronized void stop()throws Exception{
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{if(!active())return;enqueue(event("stop",value("session"),now()));value("active","0");db.setTransactionSuccessful();}finally{db.endTransaction();}
    }
    synchronized JSONArray batch()throws JSONException{JSONArray out=new JSONArray();try(Cursor c=getReadableDatabase().rawQuery("SELECT payload FROM events ORDER BY seq LIMIT 200",null)){while(c.moveToNext())out.put(new JSONObject(c.getString(0)));}return out;}
    synchronized int count(){try(Cursor c=getReadableDatabase().rawQuery("SELECT COUNT(*) FROM events",null)){c.moveToFirst();return c.getInt(0);}}
    synchronized void ack(JSONArray ids){SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{for(int i=0;i<ids.length();i++){String id=ids.optString(i);try(Cursor c=db.rawQuery("SELECT payload FROM events WHERE id=?",new String[]{id})){if(c.moveToFirst()){try{JSONObject e=new JSONObject(c.getString(0));if(e.optString("type").equals("start")&&e.optString("sessionId").equals(value("session")))value("startConfirmed","1");}catch(JSONException ignored){}}}db.delete("events","id=?",new String[]{id});}db.setTransactionSuccessful();}finally{db.endTransaction();}}
    synchronized void rejectUnconfirmedStart(){if(!value("startConfirmed").equals("0"))return;SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{try(Cursor c=db.rawQuery("SELECT id,payload FROM events",null)){while(c.moveToNext()){try{JSONObject e=new JSONObject(c.getString(1));if(e.optString("sessionId").equals(value("session")))db.delete("events","id=?",new String[]{c.getString(0)});}catch(JSONException ignored){}}}value("active","0");db.setTransactionSuccessful();}finally{db.endTransaction();}}
    private SecretKey key()throws Exception{KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);if(!ks.containsAlias("avanza-token")){KeyGenerator g=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");g.init(new KeyGenParameterSpec.Builder("avanza-token",KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());g.generateKey();}return (SecretKey)ks.getKey("avanza-token",null);}
    void token(String text)throws Exception{Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());prefs.edit().putString("token",Base64.encodeToString(c.doFinal(text.getBytes(java.nio.charset.StandardCharsets.UTF_8)),Base64.NO_WRAP)).putString("iv",Base64.encodeToString(c.getIV(),Base64.NO_WRAP)).commit();}
    String token()throws Exception{String s=prefs.getString("token","");if(s.isEmpty())return "";Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(prefs.getString("iv",""),Base64.NO_WRAP)));return new String(c.doFinal(Base64.decode(s,Base64.NO_WRAP)),java.nio.charset.StandardCharsets.UTF_8);}
    void clearToken(){prefs.edit().remove("token").remove("iv").commit();}
}
