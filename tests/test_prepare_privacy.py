import json
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import prepare_review


class PreparationPrivacyTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))

    def test_pdf_selection_stays_within_the_materials_directory(self):
        materials = self.root / "materials"
        materials.mkdir()
        policy = materials / "policy.pdf"
        policy.touch()
        alias = materials / "alias.pdf"
        alias.symlink_to(policy)
        self.assertEqual(prepare_review.material_pdfs(materials, materials.iterdir()), [alias, policy])

        outside = self.root / "other.pdf"
        outside.touch()
        (materials / "other.pdf").symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "outside the selected materials"):
            prepare_review.material_pdfs(materials, materials.iterdir())

    def test_bundle_is_owner_only_and_stays_inside_the_project(self):
        project = self.root / "project"
        project.mkdir()
        other = self.root / "other"
        other.mkdir()
        directory = project / ".local-review"
        payload = {"mode": "guide", "guide": "Staff must keep forms.", "documents": []}
        with patch.object(prepare_review, "ROOT", project):
            directory.symlink_to(other, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "inside the project"):
                prepare_review.save_private(payload)
            self.assertEqual(list(other.iterdir()), [])
            directory.unlink()
            destination = project / prepare_review.save_private(payload)
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
        self.assertEqual(json.loads(destination.read_text()), payload)
