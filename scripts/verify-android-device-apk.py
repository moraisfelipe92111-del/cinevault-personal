"""Verify the signed device-test artifact; never open any user database."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import re
import shutil
import zipfile

APP = 'com.cinevault.pessoal'
SQLITE = 'com.getcapacitor.community.database.sqlite.CapacitorSQLitePlugin'


def verify(apk, badging, certificates, expected_signer, metadata):
    if (not isinstance(metadata, dict) or metadata.get('appId') != APP or
            metadata.get('purpose') != 'android_device_test' or
            not re.fullmatch(r'\d+\.\d+\.\d+', str(metadata.get('version', ''))) or
            type(metadata.get('build')) is not int or metadata['build'] <= 15 or
            not re.fullmatch(r'[a-f0-9]{40}', str(metadata.get('sourceCommit', ''))) or
            metadata.get('sqlitePlugin') != '8.1.1'):
        raise ValueError('Identidade ou versao do teste invalida.')
    line = badging.splitlines()[0] if badging else ''
    package = dict(re.findall(r"([A-Za-z]+)='([^']*)'", line))
    if (package.get('name') != APP or package.get('versionCode') != str(metadata['build']) or
            package.get('versionName') != metadata['version'] or
            not re.search(r"^targetSdkVersion:'36'$", badging, re.MULTILINE)):
        raise ValueError('Pacote, versao ou SDK nativo divergente.')
    signer = expected_signer.strip().lower()
    actual = re.findall(r'^Signer #\d+ certificate SHA-256 digest:\s*([a-fA-F0-9]{64})\s*$', certificates, re.MULTILINE)
    if not re.fullmatch(r'[a-f0-9]{64}', signer) or len(actual) != 1 or actual[0].lower() != signer:
        raise ValueError('Certificado diferente da chave permanente esperada.')
    with zipfile.ZipFile(apk) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError('Entradas duplicadas no APK.')
        if any('cv2-native-sqlite-audit' in name for name in names):
            raise ValueError('Sonda de auditoria encontrada no APK.')
        html = archive.read('assets/public/index.html').decode('utf-8')
        if 'cv2-native-sqlite-audit' in html:
            raise ValueError('Pagina de auditoria encontrada no APK.')
        plugins = json.loads(archive.read('assets/capacitor.plugins.json'))
        if not isinstance(plugins, list) or not any(isinstance(p, dict) and p.get('classpath') == SQLITE for p in plugins):
            raise ValueError('Plugin SQLite nativo ausente.')
        if 'lib/arm64-v8a/libsqlcipher.so' not in names:
            raise ValueError('Biblioteca SQLite para Android ARM64 ausente.')
        bundles = [name for name in names if name.startswith('assets/public/assets/') and name.endswith('.js')]
        javascript = '\n'.join(archive.read(name).decode('utf-8') for name in bundles)
        if 'cinevault_personal' not in javascript or 'cinevault.personal-sqlite-authority' not in javascript:
            raise ValueError('Inicializacao SQLite real nao localizada no bundle.')
    return {**metadata, 'status': 'verified', 'sha256': sha256(Path(apk).read_bytes()).hexdigest(),
            'signerSha256': signer, 'nativeSqliteIncluded': True, 'auditProbeIncluded': False,
            'realDeviceValidation': 'pending', 'storeRelease': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--badging', type=Path, required=True)
    parser.add_argument('--certificates', type=Path, required=True)
    parser.add_argument('--expected-signer', type=Path, required=True)
    parser.add_argument('--metadata', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report = verify(args.apk, args.badging.read_text(), args.certificates.read_text(),
                    args.expected_signer.read_text(), json.loads(args.metadata.read_text()))
    args.output.mkdir(parents=True, exist_ok=False)
    filename = 'Sintonema-teste-' + report['version'] + '-build' + str(report['build']) + '.apk'
    shutil.copyfile(args.apk, args.output / filename)
    (args.output / 'SHA256SUMS.txt').write_text(report['sha256'] + '  ' + filename + '\n')
    (args.output / 'device-test-report.json').write_text(json.dumps(report, indent=2) + '\n')
    guide = f'''Sintonema - teste Android {report['version']} (build {report['build']})

Antes de instalar:
1. Abra o CineVault atual e exporte um backup recente da biblioteca. Guarde os backups anteriores.
2. Anote quantidades de favoritos/assistidos e confira suas notas e preferencias.
3. Instale o APK como atualizacao. Nao desinstale nem limpe os dados do aplicativo.
4. Se o Android recusar a atualizacao, pare e envie a mensagem de erro.

Depois de instalar:
1. Confira a versao em Configuracoes e compare seus dados com a instalacao anterior.
2. Altere um favorito, registre um assistido e uma nota; feche e reabra o aplicativo.
3. Confira fila, historico e preferencias, inclusive sem conexao.
4. Exporte a nova copia completa e mantenha esse arquivo fora do aplicativo.
5. Envie o resultado dos testes antes de prosseguirmos com restauracao e recuperacao.

Este APK testa o banco SQLite integrado. A marca visivel ainda e CineVault.
Nao e uma publicacao na Play Store. Dados de auditoria sintetica nao estao incluidos.
Se houver falha ao abrir, use a recuperacao oferecida e relate o erro; nao apague os dados.
'''
    (args.output / 'LEIA-ME-TESTE.txt').write_text(guide)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
