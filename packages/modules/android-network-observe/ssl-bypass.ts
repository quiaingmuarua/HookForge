import { Ctx, ModuleMeta } from '@core/types';
import { makeModuleLogger } from '@core/log';
import { getJavaClass } from '@core/java-utils';
import { Java, performOnJava } from '@core/java-bridge';

/**
 * 全面的 Android SSL/TLS 绕过实现
 * 合并了基础 SSL 绕过和高级网络绕过功能
 */
class SSLBypassManager {
  private moduleLog: (_msg: string, ..._args: any[]) => void;
  private quietOutput: boolean;

  constructor(moduleLog: (_msg: string, ..._args: any[]) => void, quietOutput = false) {
    this.moduleLog = moduleLog;
    this.quietOutput = quietOutput;
  }

  private quietSend(message: string, ...args: any[]) {
    if (!this.quietOutput) {
      this.moduleLog(message, ...args);
    }
  }

  /**
   * 基础 SSL 上下文绕过
   */
  bypassSSLContext() {
    try {
      const X509TrustManager = getJavaClass('javax.net.ssl.X509TrustManager', true);
      const SSLContext = getJavaClass('javax.net.ssl.SSLContext', true);
      getJavaClass('javax.net.ssl.HostnameVerifier', true);
      getJavaClass('java.security.cert.X509Certificate', true);

      // 创建自定义 TrustManager
      const TrustManager = Java.registerClass({
        name: `dev.frida.ssl.UniversalTrustManager_${Date.now()}`,
        implements: [X509TrustManager],
        methods: {
          checkClientTrusted: function (_chain: any, _authType: any) {
            // 信任所有客户端证书
          },
          checkServerTrusted: function (_chain: any, _authType: any) {
            // 信任所有服务端证书
          },
          getAcceptedIssuers: function () {
            return [];
          },
        },
      });

      let trustManagers: any[];
      try {
        trustManagers = [TrustManager.$new()];
      } catch (error) {
        this.moduleLog('SSLContext TrustManager instantiation failed: %s', error);
        return false;
      }

      // Hook SSLContext.init
      const SSLContext_init = SSLContext.init.overload(
        '[Ljavax.net.ssl.KeyManager;',
        '[Ljavax.net.ssl.TrustManager;',
        'java.security.SecureRandom'
      );

      const self = this;
      SSLContext_init.implementation = function (
        _keyManager: any,
        _trustManager: any,
        secureRandom: any
      ) {
        self.quietSend('✓ SSLContext.init bypassed with custom TrustManager');
        return SSLContext_init.call(this, _keyManager, trustManagers, secureRandom);
      };

      this.quietSend('✓ SSL Context bypass ready');
      return true;
    } catch (e) {
      this.moduleLog('✗ SSL Context bypass failed: %s', e);
      return false;
    }
  }

  /**
   * OkHttp 3.x 绕过 (增强版)
   */
  bypassOkHttp3() {
    try {
      const CertificatePinner = getJavaClass('okhttp3.CertificatePinner', true);

      // 方法1: check(String, List)
      try {
        const self = this;
        CertificatePinner.check.overload('java.lang.String', 'java.util.List').implementation =
          function (hostname: any, _certificates: any) {
            self.quietSend('✓ OkHttp3 certificate pinning bypassed for: %s', hostname);
          };
      } catch (e) {
        // Method might not exist
      }

      // 方法2: check(String, Certificate[])
      try {
        const self = this;
        CertificatePinner.check.overload(
          'java.lang.String',
          '[Ljava.security.cert.Certificate;'
        ).implementation = function (hostname: any, _certificates: any) {
          self.quietSend('✓ OkHttp3 certificate array check bypassed for: %s', hostname);
        };
      } catch (e) {
        // Method might not exist
      }

      // 方法3: check$okhttp (内部方法)
      try {
        const self = this;
        CertificatePinner['check$okhttp'].implementation = function (
          hostname: any,
          _certificates: any
        ) {
          self.quietSend('✓ OkHttp3 internal check bypassed for: %s', hostname);
        };
      } catch (e) {
        // Method might not exist
      }

      this.quietSend('✓ OkHttp 3.x bypass activated');
      return true;
    } catch (e) {
      // OkHttp 3.x not available
      return false;
    }
  }

  /**
   * OkHttp 2.x 绕过
   */
  bypassOkHttp2() {
    try {
      const OkHttpClient = getJavaClass('com.squareup.okhttp.OkHttpClient', true);
      const CertificatePinner = getJavaClass('com.squareup.okhttp.CertificatePinner', true);

      // 绕过 setCertificatePinner
      const self = this;
      OkHttpClient.setCertificatePinner.implementation = function (_certificatePinner: any) {
        self.quietSend('✓ OkHttp2 setCertificatePinner bypassed');
        return this.setCertificatePinner(null);
      };

      // 绕过证书检查
      CertificatePinner.check.overload(
        'java.lang.String',
        '[Ljava.security.cert.Certificate;'
      ).implementation = function (hostname: any, _certificates: any) {
        self.quietSend('✓ OkHttp2 certificate check bypassed for: %s', hostname);
      };

      CertificatePinner.check.overload('java.lang.String', 'java.util.List').implementation =
        function (hostname: any, _certificates: any) {
          self.quietSend('✓ OkHttp2 certificate list check bypassed for: %s', hostname);
        };

      this.quietSend('✓ OkHttp 2.x bypass activated');
      return true;
    } catch (e) {
      // OkHttp 2.x not available
      return false;
    }
  }

  /**
   * WebView SSL 绕过
   */
  bypassWebView() {
    try {
      const WebViewClient = getJavaClass('android.webkit.WebViewClient', true);

      // 绕过 SSL 错误
      const self = this;
      WebViewClient.onReceivedSslError.implementation = function (
        webView: any,
        sslErrorHandler: any,
        _sslError: any
      ) {
        self.quietSend('✓ WebView SSL error bypassed');
        sslErrorHandler.proceed();
      };

      // 绕过一般错误
      WebViewClient.onReceivedError.overload(
        'android.webkit.WebView',
        'int',
        'java.lang.String',
        'java.lang.String'
      ).implementation = function (webView: any, errorCode: any, description: any, url: any) {
        self.quietSend('✓ WebView error bypassed for: %s', url);
      };

      this.quietSend('✓ WebView SSL bypass activated');
      return true;
    } catch (e) {
      // WebView not available
      return false;
    }
  }

  /**
   * HttpsURLConnection 绕过
   */
  bypassHttpsURLConnection() {
    try {
      const HttpsURLConnection = getJavaClass('javax.net.ssl.HttpsURLConnection', true);

      const self = this;
      HttpsURLConnection.setDefaultHostnameVerifier.implementation = function (
        _hostnameVerifier: any
      ) {
        self.quietSend('✓ HttpsURLConnection default hostname verifier bypassed');
        return null;
      };

      HttpsURLConnection.setSSLSocketFactory.implementation = function (_SSLSocketFactory: any) {
        self.quietSend('✓ HttpsURLConnection SSL socket factory bypassed');
        return null;
      };

      HttpsURLConnection.setHostnameVerifier.implementation = function (_hostnameVerifier: any) {
        self.quietSend('✓ HttpsURLConnection hostname verifier bypassed');
        return null;
      };

      this.quietSend('✓ HttpsURLConnection bypass activated');
      return true;
    } catch (e) {
      // HttpsURLConnection not available
      return false;
    }
  }

  /**
   * Android 7+ Conscrypt TrustManagerImpl 绕过
   */
  bypassConscrypt() {
    try {
      const TrustManagerImpl = getJavaClass('com.android.org.conscrypt.TrustManagerImpl', true);
      const ArrayList = getJavaClass('java.util.ArrayList', true);

      // 绕过 checkTrustedRecursive (如果存在)
      const self = this;
      try {
        TrustManagerImpl.checkTrustedRecursive.implementation = function (
          _a1: any,
          _a2: any,
          _a3: any,
          _a4: any,
          _a5: any,
          _a6: any
        ) {
          self.quietSend('✓ TrustManagerImpl checkTrustedRecursive bypassed');
          return ArrayList.$new();
        };
      } catch (e) {
        // Method might not exist in all versions
      }

      // 绕过 verifyChain
      TrustManagerImpl.verifyChain.implementation = function (
        untrustedChain: any,
        _trustAnchorChain: any,
        host: any,
        _clientAuth: any,
        _ocspData: any,
        _tlsSctData: any
      ) {
        self.quietSend('✓ TrustManagerImpl verifyChain bypassed for: %s', host);
        return untrustedChain;
      };

      this.quietSend('✓ Conscrypt TrustManagerImpl bypass activated');
      return true;
    } catch (e) {
      // TrustManagerImpl not found (Android < 7.0)
      return false;
    }
  }

  /**
   * OpenSSLSocketImpl 绕过
   */
  bypassOpenSSLSocket() {
    try {
      const OpenSSLSocketImpl = getJavaClass('com.android.org.conscrypt.OpenSSLSocketImpl', true);

      const self = this;
      OpenSSLSocketImpl.verifyCertificateChain.implementation = function (
        _certRefs: any,
        _authMethod: any
      ) {
        self.quietSend('✓ OpenSSLSocketImpl certificate chain verification bypassed');
      };

      this.quietSend('✓ OpenSSLSocketImpl bypass activated');
      return true;
    } catch (e) {
      // OpenSSLSocketImpl not found
      return false;
    }
  }

  /**
   * TrustKit 绕过 (DataTheorem)
   */
  bypassTrustKit() {
    try {
      // TrustKit PinningTrustManager
      try {
        const PinningTrustManager = getJavaClass(
          'com.datatheorem.android.trustkit.pinning.PinningTrustManager',
          true
        );

        const self = this;
        PinningTrustManager.checkServerTrusted.implementation = function (
          _chain: any,
          _authType: any
        ) {
          self.quietSend('✓ TrustKit PinningTrustManager bypassed');
        };
      } catch (e) {
        // PinningTrustManager not found
      }

      // TrustKit OkHostnameVerifier
      try {
        const OkHostnameVerifier = getJavaClass(
          'com.datatheorem.android.trustkit.pinning.OkHostnameVerifier',
          true
        );

        const self = this;
        OkHostnameVerifier.verify.overload(
          'java.lang.String',
          'javax.net.ssl.SSLSession'
        ).implementation = function (hostname: any, _session: any) {
          self.quietSend('✓ TrustKit hostname verification bypassed for: %s', hostname);
          return true;
        };

        OkHostnameVerifier.verify.overload(
          'java.lang.String',
          'java.security.cert.X509Certificate'
        ).implementation = function (hostname: any, _cert: any) {
          self.quietSend('✓ TrustKit certificate verification bypassed for: %s', hostname);
          return true;
        };

        // 绕过带更多参数的 check 方法
        try {
          OkHostnameVerifier.check.overload(
            'java.lang.String',
            '[Ljava.security.cert.Certificate;',
            'java.lang.String',
            '[Ljava.lang.String;',
            'java.util.Date'
          ).implementation = function (
            hostname: any,
            _chain: any,
            _pinsSha256: any,
            _includeSubdomains: any,
            _expirationDate: any
          ) {
            self.quietSend('✓ TrustKit detailed check bypassed for: %s', hostname);
          };
        } catch (e) {
          // Method might not exist
        }
      } catch (e) {
        // OkHostnameVerifier not found
      }

      this.quietSend('✓ TrustKit bypass activated');
      return true;
    } catch (e) {
      // TrustKit not available
      return false;
    }
  }

  /**
   * Chromium Cronet 绕过
   */
  bypassCronet() {
    try {
      const CronetBuilder = getJavaClass('org.chromium.net.CronetEngine$Builder', true);

      // 绕过公钥固定
      const self = this;
      CronetBuilder.enablePublicKeyPinningBypassForLocalTrustAnchors.implementation = function (
        _enabled: any
      ) {
        self.quietSend('✓ Cronet public key pinning bypass enabled');
        return CronetBuilder.enablePublicKeyPinningBypassForLocalTrustAnchors.call(this, true);
      };

      // 绕过添加公钥固定
      CronetBuilder.addPublicKeyPins.implementation = function (
        hostname: any,
        _pinsSha256: any,
        _includeSubdomains: any,
        _expirationDate: any
      ) {
        self.quietSend('✓ Cronet public key pins bypassed for: %s', hostname);
        return this;
      };

      this.quietSend('✓ Cronet bypass activated');
      return true;
    } catch (e) {
      // Cronet not available
      return false;
    }
  }

  /**
   * Boye HttpClient 绕过
   */
  bypassBoye() {
    try {
      const AbstractVerifier = getJavaClass(
        'ch.boye.httpclientandroidlib.conn.ssl.AbstractVerifier',
        true
      );

      const self = this;
      AbstractVerifier.verify.implementation = function (hostname: any, _ssl: any) {
        self.quietSend('✓ Boye HttpClient verification bypassed for: %s', hostname);
      };

      this.quietSend('✓ Boye HttpClient bypass activated');
      return true;
    } catch (e) {
      // Boye HttpClient not available
      return false;
    }
  }

  /**
   * 执行全面的 SSL/TLS 绕过
   */
  bypassAll() {
    this.moduleLog('🔐 Starting comprehensive SSL/TLS bypass...');

    const methods = [
      { name: 'SSL Context', fn: () => this.bypassSSLContext() },
      { name: 'OkHttp 3.x', fn: () => this.bypassOkHttp3() },
      { name: 'OkHttp 2.x', fn: () => this.bypassOkHttp2() },
      { name: 'WebView', fn: () => this.bypassWebView() },
      { name: 'HttpsURLConnection', fn: () => this.bypassHttpsURLConnection() },
      { name: 'Conscrypt', fn: () => this.bypassConscrypt() },
      { name: 'OpenSSL Socket', fn: () => this.bypassOpenSSLSocket() },
      { name: 'TrustKit', fn: () => this.bypassTrustKit() },
      { name: 'Cronet', fn: () => this.bypassCronet() },
      { name: 'Boye HttpClient', fn: () => this.bypassBoye() },
    ];

    let successCount = 0;
    for (const method of methods) {
      try {
        if (method.fn()) {
          successCount++;
        }
      } catch (e) {
        this.moduleLog('✗ %s bypass failed: %s', method.name, e);
      }
    }

    this.moduleLog(
      '🎯 SSL/TLS bypass completed: %d/%d methods activated',
      successCount,
      methods.length
    );
  }

  /**
   * 执行基础的 SSL/TLS 绕过
   */
  bypassBasic() {
    this.moduleLog('🔐 Starting basic SSL/TLS bypass...');

    const basicMethods = [
      { name: 'SSL Context', fn: () => this.bypassSSLContext() },
      { name: 'OkHttp 3.x', fn: () => this.bypassOkHttp3() },
      { name: 'HttpsURLConnection', fn: () => this.bypassHttpsURLConnection() },
      { name: 'Conscrypt', fn: () => this.bypassConscrypt() },
    ];

    let successCount = 0;
    for (const method of basicMethods) {
      try {
        if (method.fn()) {
          successCount++;
        }
      } catch (e) {
        this.moduleLog('✗ %s bypass failed: %s', method.name, e);
      }
    }

    this.moduleLog(
      '🎯 Basic SSL/TLS bypass completed: %d/%d methods activated',
      successCount,
      basicMethods.length
    );
  }
}

async function activate(ctx: Ctx) {
  const { env, log, cfg } = ctx;

  if (env.platform !== 'android' || !env.javaAvailable) {
    log('SSL bypass skipped: not Android or Java not available');
    return;
  }

  const moduleLog = makeModuleLogger('ssl-bypass');
  const quietOutput = cfg.flags?.['ssl.quiet'] || false;
  const comprehensiveMode = cfg.flags?.['ssl.comprehensive'] !== false;

  await performOnJava(() => {
    try {
      const sslBypass = new SSLBypassManager(moduleLog, quietOutput);

      if (comprehensiveMode) {
        sslBypass.bypassAll();
      } else {
        sslBypass.bypassBasic();
      }

      moduleLog('🚀 Android SSL/TLS bypass module fully activated');
    } catch (e) {
      moduleLog('❌ SSL bypass setup failed: %s', e);
    }
  });

  log('Android SSL/TLS bypass module activated');
}

export const meta: ModuleMeta = {
  id: 'android/ssl-bypass',
  selector: {
    platform: 'android',
    layer: 'java',
    tags: ['bypass', 'ssl', 'https', 'certificate', 'network', 'comprehensive'],
  },
  priority: 15,
  activate,
};
