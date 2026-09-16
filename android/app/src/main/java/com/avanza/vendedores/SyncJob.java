package com.avanza.vendedores;
import android.app.job.*;
import android.content.*;
public final class SyncJob extends JobService {
    static void schedule(Context c){if(Store.get(c).count()==0||Store.get(c).value("authRequired").equals("1"))return;JobInfo info=new JobInfo.Builder(17,new ComponentName(c,SyncJob.class)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setMinimumLatency(60000).setBackoffCriteria(60000,JobInfo.BACKOFF_POLICY_EXPONENTIAL).setPersisted(true).build();c.getSystemService(JobScheduler.class).schedule(info);}
    public boolean onStartJob(JobParameters parameters){Api.IO.execute(()->{boolean ok=Api.sync(this);jobFinished(parameters,!ok&&!Store.get(this).value("authRequired").equals("1"));});return true;}
    public boolean onStopJob(JobParameters parameters){return true;}
}
