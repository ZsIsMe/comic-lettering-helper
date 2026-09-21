"""Offline safety checks for dual release publication (no external mutations)."""
import importlib.util
from pathlib import Path
from unittest.mock import patch
import unittest

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('publish-release.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublicationTests(unittest.TestCase):
    def test_remote_tag_must_match_peeled_commit(self):
        refs = 'tag-object\trefs/tags/0.2.10\ncommit\trefs/tags/0.2.10^{}\n'
        with patch.object(publisher, 'run', return_value=refs):
            publisher.check_remote_tag('gitee.com', '0.2.10', 'commit')
            with self.assertRaises(ValueError):
                publisher.check_remote_tag('gitee.com', '0.2.10', 'different')
        with patch.object(publisher, 'run', return_value=''):
            with self.assertRaises(ValueError):
                publisher.check_remote_tag('gitee.com', '0.2.10', 'commit')

    def test_resume_only_uploads_missing_attachment(self):
        calls = []
        release = {'id': 1, 'name': '0.2.10', 'body': 'notes', 'prerelease': False}

        def api(path, fields=None, file=None):
            calls.append((path, fields, file))
            if '/tags/' in path:
                return release
            if fields is None:
                return [{'name': 'application.zip', 'browser_download_url': 'https://example.org/bundle'}]
            return {'browser_download_url': 'https://example.org/checksum'}

        with patch.object(publisher, 'gitee', side_effect=api), \
             patch.object(Path, 'read_text', return_value='notes'), \
             patch.object(publisher, 'verify_download') as verify:
            publisher.publish_gitee('0.2.10', 'commit', '0.2.10', Path('notes'),
                                    {'application.zip': b'zip', 'application.zip.sha256': b'sha'})
        writes = [call for call in calls if call[1] is not None]
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0][2][0], 'application.zip.sha256')
        self.assertEqual(verify.call_count, 2)

    def test_existing_mismatched_attachment_never_overwritten(self):
        def api(path, fields=None, file=None):
            self.assertIsNone(fields, 'Must not mutate after finding conflicting content')
            if '/tags/' in path:
                return {'id': 1, 'name': '0.2.10', 'body': 'notes', 'prerelease': False}
            return [{'name': 'application.zip', 'browser_download_url': 'https://example.org/file'}]
        with patch.object(publisher, 'gitee', side_effect=api), \
             patch.object(Path, 'read_text', return_value='notes'), \
             patch.object(publisher, 'verify_download', side_effect=ValueError('mismatch')):
            with self.assertRaises(ValueError):
                publisher.publish_gitee('0.2.10', 'commit', '0.2.10', Path('notes'),
                                        {'application.zip': b'zip'})

    def test_login_html_rejected_as_download(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return b'<html>login</html>'[:limit]
        with patch.object(publisher, 'urlopen', return_value=Response()):
            with self.assertRaises(ValueError):
                publisher.verify_download('https://example.org/file', b'zip')

    def test_missing_token_prevents_all_publication(self):
        with patch('sys.argv', ['publish-release.py', '0.2.10', '.', '--notes-file', 'notes', '--apply']), \
             patch.object(Path, 'read_text', return_value='notes'), \
             patch.object(publisher, 'validate_bundle', return_value=({'application.zip': b'zip'}, 'commit')), \
             patch.object(publisher, 'check_remote_tag'), \
             patch.dict(publisher.os.environ, {}, clear=True), \
             patch.object(publisher.sys, 'platform', 'linux'), \
             patch.object(publisher, 'publish_github') as github:
            with self.assertRaisesRegex(ValueError, 'GITEE_TOKEN'):
                publisher.main()
            github.assert_not_called()


if __name__ == '__main__':
    unittest.main()
