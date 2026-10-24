"""Artifact verification refuses incompatible or audit-only APK payloads."""
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('device_apk', Path(__file__).resolve().parents[1] / 'scripts/verify-android-device-apk.py')
device = importlib.util.module_from_spec(spec)
spec.loader.exec_module(device)


class DeviceApkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.apk = self.root / 'candidate.apk'
        self.meta = {'appId': device.APP, 'purpose': 'android_device_test', 'version': '1.3.3',
                     'build': 16, 'sourceCommit': 'a' * 40, 'sqlitePlugin': '8.1.1'}
        self.badging = "package: name='com.cinevault.pessoal' versionCode='16' versionName='1.3.3'\ntargetSdkVersion:'36'\n"
        self.signer = 'b' * 64
        self.cert = 'Signer #1 certificate SHA-256 digest: ' + self.signer + '\n'
        self.payload = {
            'assets/public/index.html': '<div id="root"></div><script src="/assets/index.js"></script>',
            'assets/public/assets/index.js': 'const db="cinevault_personal";const authority="cinevault.personal-sqlite-authority";const media="cv_media_revision";const backup="sintonema.audiovisual-backup";',
            'assets/capacitor.plugins.json': json.dumps([{'classpath': device.SQLITE}]),
            'lib/arm64-v8a/libsqlcipher.so': 'fixture only',
        }
        self.pack()

    def pack(self):
        with zipfile.ZipFile(self.apk, 'w') as archive:
            for name, value in self.payload.items():
                archive.writestr(name, value)

    def verify(self, **values):
        return device.verify(self.apk, values.get('badging', self.badging),
                             values.get('certificates', self.cert), values.get('expected_signer', self.signer),
                             values.get('metadata', self.meta))

    def test_real_application_artifact_is_verified_without_mutation(self):
        original = self.apk.read_bytes()
        report = self.verify()
        self.assertEqual(report['sha256'], sha256(original).hexdigest())
        self.assertEqual(self.apk.read_bytes(), original)
        self.assertEqual(report['realDeviceValidation'], 'pending')
        self.assertFalse(report['storeRelease'])

    def test_audit_file_or_injected_html_cannot_be_distributed(self):
        for name in ['assets/public/cv2-native-sqlite-audit.js', 'assets/public/index.html']:
            with self.subTest(name=name):
                original = self.payload.copy()
                self.payload[name] = '<script src="/cv2-native-sqlite-audit.js"></script>'
                self.pack()
                with self.assertRaises(ValueError):
                    self.verify()
                self.payload = original

    def test_missing_native_sqlite_or_arm64_library_is_refused(self):
        for name in ['assets/capacitor.plugins.json', 'lib/arm64-v8a/libsqlcipher.so']:
            with self.subTest(name=name):
                original = self.payload.copy()
                self.payload.pop(name)
                if name.endswith('.json'):
                    self.payload[name] = '[]'
                self.pack()
                with self.assertRaises(ValueError):
                    self.verify()
                self.payload = original

    def test_wrong_package_build_version_and_sdk_are_refused(self):
        for old, new in [('com.cinevault.pessoal', 'com.example.other'), ("versionCode='16'", "versionCode='15'"),
                         ("versionName='1.3.3'", "versionName='1.3.2'"), ("targetSdkVersion:'36'", "targetSdkVersion:'35'")]:
            with self.subTest(old=old), self.assertRaises(ValueError):
                self.verify(badging=self.badging.replace(old, new))

    def test_mismatched_missing_or_multiple_certificate_reports_are_refused(self):
        for certificate in ['', self.cert.replace(self.signer, 'c' * 64), self.cert + self.cert.replace('#1', '#2')]:
            with self.subTest(certificate=certificate), self.assertRaises(ValueError):
                self.verify(certificates=certificate)

    def test_unrelated_web_bundle_cannot_claim_real_sqlite_initialization(self):
        for marker in ['cv_media_revision', 'sintonema.audiovisual-backup']:
            original = self.payload['assets/public/assets/index.js']
            self.payload['assets/public/assets/index.js'] = original.replace(marker, 'old-version')
            self.pack()
            with self.assertRaises(ValueError):
                self.verify()
            self.payload['assets/public/assets/index.js'] = original
        self.payload['assets/public/assets/index.js'] = 'console.log("another application")'
        self.pack()
        with self.assertRaises(ValueError):
            self.verify()

    def test_invalid_or_old_metadata_is_refused(self):
        for change in [{'build': 15}, {'build': True}, {'sourceCommit': 'not-a-commit'}, {'purpose': 'native_audit'},
                       {'version': '1.3.3\ninvalid'}, {'appId': 'com.example.other'}, {'sqlitePlugin': '7.0.0'}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.verify(metadata={**self.meta, **change})

    def test_cli_delivers_exact_verified_apk_hash_report_and_test_guide(self):
        files = {'badging': self.badging, 'certificates': self.cert, 'expected-signer': self.signer,
                 'metadata': json.dumps(self.meta)}
        args = ['verify-device', '--apk', str(self.apk), '--output', str(self.root / 'delivery')]
        for name, text in files.items():
            path = self.root / (name + '.txt')
            path.write_text(text)
            args += ['--' + name, str(path)]
        with patch('sys.argv', args), patch('builtins.print'):
            device.main()
        out = self.root / 'delivery'
        report = json.loads((out / 'device-test-report.json').read_text())
        apk = out / 'Sintonema-teste-1.3.3-build16.apk'
        self.assertEqual(apk.read_bytes(), self.apk.read_bytes())
        self.assertEqual((out / 'SHA256SUMS.txt').read_text(), report['sha256'] + '  ' + apk.name + '\n')
        self.assertIn('Nao desinstale', (out / 'LEIA-ME-TESTE.txt').read_text())


if __name__ == '__main__':
    unittest.main()
