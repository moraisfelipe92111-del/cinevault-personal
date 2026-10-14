package com.cinevault.pessoal;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/** Optional sideload updater. Installed app must be signed with the same key as the next APK. */
@CapacitorPlugin(name = "CineVaultUpdater")
public class CineVaultUpdaterPlugin extends Plugin {
  private static final String PATH_PREFIX = "/moraisfelipe92111-del/cinevault-personal/releases/download/";
  private final AtomicBoolean busy = new AtomicBoolean(false);

  @PluginMethod
  public void getInstalledVersion(PluginCall call) {
    try {
      PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
      JSObject result = new JSObject();
      result.put("version", info.versionName);
      result.put("build", versionCode(info));
      call.resolve(result);
    } catch (Exception e) { call.reject("Versão instalada indisponível."); }
  }

  @PluginMethod
  public void downloadAndInstall(PluginCall call) {
    final String url = call.getString("url", "");
    final String sha = call.getString("sha256", "").toLowerCase(Locale.ROOT);
    final int candidate = call.getInt("build", 0);
    if (!validInitialUrl(url) || !sha.matches("[0-9a-f]{64}")) { call.reject("Manifesto da atualização inválido."); return; }
    try {
      PackageInfo installed = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
      if (candidate <= versionCode(installed)) { call.reject("Esta versão não é mais nova que a instalada."); return; }
    } catch (Exception e) { call.reject("Não foi possível ler a versão instalada."); return; }
    if (!busy.compareAndSet(false, true)) { call.reject("Já existe uma atualização em andamento."); return; }
    new Thread(() -> {
      try {
        File dir = new File(getContext().getCacheDir(), "cinevault-updates");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("Não foi possível criar pasta temporária.");
        File apk = new File(dir, "verified-" + candidate + ".apk");
        if (!apk.isFile() || !sha.equals(sha256(apk))) download(url, sha, apk);
        verifyArchive(apk, candidate);
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
          getActivity().runOnUiThread(() -> {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
              Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(settings);
          });
          JSObject response = new JSObject(); response.put("status", "permission_required"); call.resolve(response);
          return;
        }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".cinevault-updater", apk);
        getActivity().runOnUiThread(() -> {
          try {
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(uri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(install);
            JSObject response = new JSObject(); response.put("status", "installer_opened"); call.resolve(response);
          } catch (Exception e) { call.reject("Instalador Android indisponível: " + e.getMessage()); }
        });
      } catch (Exception e) { call.reject("Atualização bloqueada: " + e.getMessage()); }
      finally {busy.set(false);}
    }, "cinevault-updater").start();
  }

  private boolean validInitialUrl(String raw) {
    try {
      URL u = new URL(raw);
      return "https".equals(u.getProtocol()) && "github.com".equalsIgnoreCase(u.getHost()) &&
        u.getUserInfo() == null && u.getQuery() == null && u.getRef() == null &&
        u.getPath().startsWith(PATH_PREFIX) && u.getPath().matches(".*/releases/download/v[0-9]+\\.[0-9]+\\.[0-9]+/[^/]+\\.apk");
    } catch (Exception e) {return false;}
  }
  private boolean allowedRedirect(URL u) {
    String host = u.getHost().toLowerCase(Locale.ROOT);
    return "https".equalsIgnoreCase(u.getProtocol()) &&
       ("github.com".equals(host) || host.endsWith(".githubusercontent.com")) && u.getUserInfo() == null;
  }
  private void download(String raw, String expected, File out) throws Exception {
    File part = new File(out.getParentFile(), out.getName() + ".part");
    HttpURLConnection con = null;
    try {
      URL next = new URL(raw);
      int redirects = 0;
      while (true) {
        if (!allowedRedirect(next)) throw new Exception("Redirecionamento fora dos servidores oficiais.");
        con = (HttpURLConnection) next.openConnection();
        con.setInstanceFollowRedirects(false);
        con.setConnectTimeout(12000); con.setReadTimeout(30000);
        con.setRequestProperty("User-Agent", "CineVault-Android-Updater/1.2");
        int status = con.getResponseCode();
        if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
          if (++redirects > 6) throw new Exception("Muitos redirecionamentos.");
          String location = con.getHeaderField("Location");
          if (location == null) throw new Exception("Redirecionamento sem destino.");
          next = new URL(next, location);
          con.disconnect(); con = null; continue;
        }
        if (status != 200) throw new Exception("Servidor retornou HTTP " + status);
        break;
      }
      final long max = 200L * 1024L * 1024L;
      long length = con.getContentLengthLong();
      if (length > max) throw new Exception("Arquivo maior que o limite de segurança.");
      long total = 0; int lastPct = -1;
      try (InputStream in = con.getInputStream(); FileOutputStream dest = new FileOutputStream(part)) {
        byte[] chunk = new byte[32768]; int count;
        while ((count = in.read(chunk)) != -1) {
          total += count;
          if (total > max) throw new Exception("Download acima do limite de segurança.");
          dest.write(chunk,0,count);
          if (length > 0) {
            int pct=(int)Math.min(100,total*100/length);
            if(pct!=lastPct) {lastPct=pct; JSObject progress=new JSObject();progress.put("percent",pct);notifyListeners("downloadProgress",progress);}
          }
        }
        dest.getFD().sync();
      }
      if (total < 10000 || !expected.equals(sha256(part))) throw new Exception("SHA-256 incorreto ou APK incompleto.");
      if (out.exists() && !out.delete()) throw new Exception("Não foi possível substituir o APK antigo.");
      if (!part.renameTo(out)) throw new Exception("Não foi possível finalizar o arquivo.");
    } finally {if (con != null) con.disconnect(); if (part.exists()) part.delete();}
  }
  private String sha256(File file) throws Exception {
    MessageDigest dig = MessageDigest.getInstance("SHA-256");
    try (FileInputStream in = new FileInputStream(file)) {
      byte[] bytes = new byte[32768];int count;
      while ((count=in.read(bytes))!=-1)dig.update(bytes,0,count);
    }
    StringBuilder sb = new StringBuilder();
    for (byte b:dig.digest())sb.append(String.format(Locale.ROOT,"%02x", b & 0xff));
    return sb.toString();
  }
  private long versionCode(PackageInfo i) {return Build.VERSION.SDK_INT>=28?i.getLongVersionCode():i.versionCode;}
  private Signature[] signers(PackageInfo i) {
    if (Build.VERSION.SDK_INT>=28) {
      if (i.signingInfo==null)return null;
      return i.signingInfo.hasMultipleSigners()?i.signingInfo.getApkContentsSigners():i.signingInfo.getSigningCertificateHistory();
    }
    return i.signatures;
  }
  private void verifyArchive(File apk,long requestedVersion) throws Exception {
    PackageManager pm=getContext().getPackageManager();
    int flags=Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES;
    PackageInfo installed=pm.getPackageInfo(getContext().getPackageName(),flags);
    PackageInfo candidate=pm.getPackageArchiveInfo(apk.getAbsolutePath(),flags);
    if(candidate==null || !getContext().getPackageName().equals(candidate.packageName))throw new Exception("Pacote Android diferente.");
    if(versionCode(candidate)!=requestedVersion||versionCode(candidate)<=versionCode(installed))throw new Exception("VersionCode inválido.");
    Signature[] a=signers(installed),b=signers(candidate);
    if(a==null||b==null||a.length==0||b.length==0)throw new Exception("Assinaturas não identificadas.");
    if(a.length!=b.length)throw new Exception("Quantidade de assinantes diferente.");
    for(Signature installedSigner:a){
      boolean match=false;
      for(Signature updateSigner:b){if(Arrays.equals(installedSigner.toByteArray(),updateSigner.toByteArray()))match=true;}
      if(!match)throw new Exception("APK não assinado pela chave instalada.");
    }
  }
}
