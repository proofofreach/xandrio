import os
import platform
from datetime import date, datetime

from calibre.gui2 import error_dialog, info_dialog, question_dialog
from calibre.gui2.actions import InterfaceAction
from qt.core import QAction, QInputDialog, QLineEdit, QMenu, QProgressDialog, Qt

from calibre_plugins.xandrio.config import prefs
from calibre_plugins.xandrio.network import XandrioRequestError, request_json, upload_book


FORMAT_PRIORITY = ('EPUB', 'AZW3', 'MOBI', 'PRC', 'AZW', 'PDF')


def iso_value(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value) if value else None


class XandrioAction(InterfaceAction):
    name = 'Xandrio'
    action_spec = ('Xandrio', None, 'Send books to Xandrio', None)
    action_type = 'current'

    def genesis(self):
        menu = QMenu(self.gui)
        self.send_selected_action = QAction('Send selected books', self.gui)
        self.send_selected_action.triggered.connect(self.send_selected)
        menu.addAction(self.send_selected_action)

        self.send_all_action = QAction('Send entire library', self.gui)
        self.send_all_action.triggered.connect(self.send_all)
        menu.addAction(self.send_all_action)
        menu.addSeparator()

        self.connect_action = QAction('Connect to Xandrio…', self.gui)
        self.connect_action.triggered.connect(self.connect_to_xandrio)
        menu.addAction(self.connect_action)

        self.disconnect_action = QAction('Forget connection', self.gui)
        self.disconnect_action.triggered.connect(self.disconnect)
        menu.addAction(self.disconnect_action)

        self.qaction.setMenu(menu)
        self.qaction.triggered.connect(self.send_selected)
        self._refresh_actions()

    def initialization_complete(self):
        self._refresh_actions()

    def _refresh_actions(self):
        connected = bool(prefs['server_url'] and prefs['token'])
        self.send_selected_action.setEnabled(connected)
        self.send_all_action.setEnabled(connected)
        self.disconnect_action.setEnabled(connected)

    def connect_to_xandrio(self):
        current_url = prefs['server_url'] or 'http://127.0.0.1:8181'
        server_url, accepted = QInputDialog.getText(
            self.gui, 'Connect to Xandrio', 'Xandrio address:', QLineEdit.EchoMode.Normal, current_url
        )
        if not accepted or not server_url.strip():
            return
        code, accepted = QInputDialog.getText(
            self.gui, 'Connect to Xandrio',
            'Pairing code from Xandrio Settings → Calibre:', QLineEdit.EchoMode.Normal, ''
        )
        if not accepted:
            return
        client_name = '%s · %s' % (platform.node() or 'Computer', platform.system())
        try:
            claimed = request_json(
                server_url, '/api/integrations/calibre/claim', method='POST',
                payload={'code': ''.join(character for character in code if character.isdigit()), 'clientName': client_name}
            )
            prefs['server_url'] = server_url.strip().rstrip('/')
            prefs['token'] = claimed['token']
            prefs['client_name'] = client_name
            request_json(prefs['server_url'], '/api/integrations/calibre/status', token=prefs['token'])
            self._refresh_actions()
            info_dialog(self.gui, 'Xandrio connected', 'Calibre can now send books to Xandrio.', show=True)
        except (XandrioRequestError, KeyError) as error:
            error_dialog(self.gui, 'Could not connect', str(error), show=True)

    def disconnect(self):
        prefs['server_url'] = ''
        prefs['token'] = ''
        self._refresh_actions()
        info_dialog(self.gui, 'Xandrio disconnected', 'This local connection was forgotten. You can also revoke it in Xandrio Settings.', show=True)

    def send_selected(self):
        ids = list(self.gui.library_view.get_selected_ids())
        if not ids:
            info_dialog(self.gui, 'No books selected', 'Select one or more books first.', show=True)
            return
        self._send(ids, 'selected books')

    def send_all(self):
        ids = sorted(self.gui.current_db.new_api.all_book_ids())
        self._send(ids, 'entire library')

    def _library_uuid(self, db):
        for owner in (db, getattr(db, 'backend', None), self.gui.current_db):
            value = getattr(owner, 'library_id', None) if owner is not None else None
            if value:
                return str(value)
        return str(getattr(self.gui.current_db, 'library_path', 'calibre-library'))

    def _metadata(self, db, library_uuid, book_id):
        metadata = db.get_metadata(book_id)
        identifiers = metadata.get_identifiers() or {}
        languages = list(metadata.languages or [])
        last_modified = db.field_for('last_modified', book_id)
        return {
            'libraryUuid': library_uuid,
            'bookUuid': str(metadata.uuid or book_id),
            'calibreId': str(book_id),
            'title': metadata.title,
            'authors': list(metadata.authors or []),
            'language': languages[0] if languages else None,
            'isbn': identifiers.get('isbn'),
            'publisher': metadata.publisher,
            'publishedDate': iso_value(metadata.pubdate),
            'description': metadata.comments,
            'tags': list(metadata.tags or []),
            'series': metadata.series,
            'seriesIndex': metadata.series_index,
            'lastModified': iso_value(last_modified)
        }

    def _preferred_format(self, db, book_id):
        available = set(db.formats(book_id) or ())
        return next((fmt for fmt in FORMAT_PRIORITY if fmt in available), None)

    def _send(self, ids, label):
        if not prefs['server_url'] or not prefs['token']:
            self.connect_to_xandrio()
            if not prefs['token']:
                return
        db = self.gui.current_db.new_api
        library_uuid = self._library_uuid(db)
        try:
            inventory = request_json(
                prefs['server_url'], '/api/integrations/calibre/inventory', token=prefs['token']
            ).get('books', [])
        except XandrioRequestError as error:
            error_dialog(self.gui, 'Could not reach Xandrio', str(error), show=True)
            return
        remote = {
            (item.get('libraryUuid'), item.get('bookUuid')): item.get('lastModified')
            for item in inventory
        }
        plans = []
        unsupported = 0
        unchanged = 0
        for book_id in ids:
            metadata = self._metadata(db, library_uuid, book_id)
            fmt = self._preferred_format(db, book_id)
            if not fmt:
                unsupported += 1
                continue
            identity = (metadata['libraryUuid'], metadata['bookUuid'])
            if identity in remote and remote[identity] == metadata.get('lastModified'):
                unchanged += 1
                continue
            plans.append((book_id, fmt, metadata))

        message = (
            'Send %d book%s from the %s?\n\n'
            '%d unchanged book%s will be skipped. %d book%s have no supported format.'
        ) % (
            len(plans), '' if len(plans) == 1 else 's', label,
            unchanged, '' if unchanged == 1 else 's',
            unsupported, '' if unsupported == 1 else 's'
        )
        if not plans:
            info_dialog(self.gui, 'Nothing to send', message, show=True)
            return
        if not question_dialog(self.gui, 'Send to Xandrio', message):
            return

        progress = QProgressDialog('Preparing books…', 'Cancel', 0, len(plans), self.gui)
        progress.setWindowTitle('Sending to Xandrio')
        progress.setWindowModality(Qt.WindowModality.WindowModal)
        progress.setMinimumDuration(0)
        imported = 0
        updated = 0
        already_present = unchanged
        failures = []
        warnings = []
        processed = 0
        canceled = False
        for index, (book_id, fmt, metadata) in enumerate(plans):
            if progress.wasCanceled():
                canceled = True
                break
            progress.setValue(index)
            progress.setLabelText('%s · %s of %s' % (metadata.get('title') or 'Untitled', index + 1, len(plans)))
            path = None
            try:
                path = db.format(book_id, fmt, as_path=True, preserve_filename=True)
                if not path:
                    raise XandrioRequestError('%s format is unavailable.' % fmt)
                cover_bytes = db.cover(book_id)
                result = upload_book(prefs['server_url'], prefs['token'], metadata, path, cover_bytes)
                if cover_bytes and result.get('coverStatus') != 'imported':
                    warnings.append('%s: Xandrio kept its existing cover.' % (metadata.get('title') or book_id))
                if result.get('status') == 'already-present':
                    already_present += 1
                elif result.get('status') in ('updated', 'linked'):
                    updated += 1
                else:
                    imported += 1
            except Exception as error:
                failures.append('%s: %s' % (metadata.get('title') or book_id, error))
            finally:
                if path:
                    try:
                        os.remove(path)
                    except OSError:
                        pass
            processed += 1
        progress.setValue(processed if canceled else len(plans))
        summary = '%d imported · %d updated · %d already current · %d unsupported' % (
            imported, updated, already_present, unsupported
        )
        if canceled:
            summary += ' · %d not sent' % (len(plans) - processed)
        if warnings:
            summary += ' · %d cover warning%s' % (len(warnings), '' if len(warnings) == 1 else 's')
        if failures:
            error_dialog(
                self.gui, 'Xandrio import finished with errors', summary,
                det_msg='\n'.join((failures + warnings)[:50]), show=True
            )
        elif warnings:
            info_dialog(self.gui, 'Xandrio import complete with warnings', summary, det_msg='\n'.join(warnings[:50]), show=True)
        elif canceled:
            info_dialog(self.gui, 'Xandrio send stopped', summary, show=True)
        else:
            info_dialog(self.gui, 'Xandrio import complete', summary, show=True)
