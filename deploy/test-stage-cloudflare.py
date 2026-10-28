import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('stage', Path(__file__).with_name('stage-cloudflare.py'))
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)

class ConfigurationStaging(unittest.TestCase):
    def setUp(self):
        self.payload = {
            'AI_PROVIDER': 'cloudflare', 'AI_ENABLED': 'true', 'CLOUDFLARE_ACCOUNT_ID': '1' * 32,
            'CLOUDFLARE_API_TOKEN': 'fake-token-for-offline-tests-only',
            'CLOUDFLARE_MODEL': '@cf/black-forest-labs/flux-2-klein-4b', 'AI_LAB_ENABLED': 'true',
            'AI_LAB_PROXY_TOKEN': 'a' * 64, 'AI_TIMEOUT_MS': '45000', 'AI_MAX_CONCURRENT': '2',
            'AI_DAILY_REQUEST_LIMIT': '50', 'AI_SESSION_DAILY_REQUEST_LIMIT': '50', 'AI_DAILY_NEURON_LIMIT': '8000',
            'DATABASE_PATH': '/var/www/paypal-delight-ai/shared/delight-stage5.sqlite',
        }
        self.runtime = '# keep this\nPAYPAL_CLIENT_SECRET=offline-fixture\nDATABASE_PATH=/shared/delight.sqlite\nAI_PROVIDER=mock\nAI_ENABLED=false\n'

    def test_preserves_payment_and_uses_separate_database(self):
        result, nginx = stage.prepare(self.runtime, self.payload)
        self.assertIn('PAYPAL_CLIENT_SECRET=offline-fixture\n', result)
        self.assertIn('DATABASE_PATH=/var/www/paypal-delight-ai/shared/delight-stage5.sqlite\n', result)
        self.assertEqual(result.count('AI_PROVIDER='), 1)
        self.assertIn('AI_ENABLED=true', result)
        self.assertEqual(nginx, 'set $delight_lab_token "' + 'a' * 64 + '";\n')

    def test_only_allowlisted_keys_and_model(self):
        for extra in [{'DATABASE_PATH': '/different'}, {'CLOUDFLARE_MODEL': '@cf/unapproved'}, {'AI_PROVIDER': 'openai'}, {'AI_ENABLED': 'false'}]:
            with self.assertRaises(ValueError): stage.prepare(self.runtime, {**self.payload, **extra})

    def test_rejects_injection_and_excessive_limits(self):
        for key, value in [('CLOUDFLARE_API_TOKEN', 'a' * 32 + '\nAI_ENABLED=true'), ('AI_LAB_PROXY_TOKEN', '";evil;'), ('AI_DAILY_NEURON_LIMIT', '10000'), ('AI_MAX_CONCURRENT', '0')]:
            with self.assertRaises(ValueError): stage.prepare(self.runtime, {**self.payload, key: value})

    def test_staging_leaves_live_settings_untouched_and_does_not_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'runtime.env').write_text(self.runtime)
            release = '20261027T120000Z-931d85a'
            stage.stage(release, json.loads(json.dumps(self.payload)), root)
            self.assertEqual((root / 'runtime.env').read_text(), self.runtime)
            self.assertTrue((root / ('next-' + release + '.env')).exists())
            self.assertTrue((root / ('next-' + release + '.conf')).exists())
            if os.name != 'nt': self.assertEqual((root / ('next-' + release + '.env')).stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError): stage.stage(release, self.payload, root)

    def test_release_paths_are_bounded(self):
        with self.assertRaises(ValueError): stage.stage('../../runtime', self.payload)

if __name__ == '__main__': unittest.main()
