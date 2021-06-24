/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2020 Corporation for Digital Scholarship
                     Vienna, Virginia, USA
                     https://digitalscholar.org
    
    This file is part of Zotero.
    
    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/

// TODO: Fix import/require related issues that might be
//  related with `require` not reusing the context
var React = require('react');
var ReactDOM = require('react-dom');
var TagsBoxContainer = require('containers/tagsBoxContainer').default;
var NotesList = require('components/itemPane/notesList').default;

var ZoteroContextPane = new function () {
	const HTML_NS = 'http://www.w3.org/1999/xhtml';
	
	var _tabCover;
	var _contextPane;
	var _contextPaneInner;
	var _contextPaneSplitter;
	var _contextPaneSplitterStacked;
	var _itemToggle;
	var _notesToggle;
	var _panesDeck;
	var _itemPaneDeck;
	var _notesPaneDeck;
	
	var _splitButton;
	var _itemPaneToggle;
	var _notesPaneToggle;
	var _tabToolbar;
	
	var _itemContexts = [];
	var _notesContexts = [];
	
	// Using attribute instead of property to set 'selectedIndex'
	// is more reliable
	
	this.update = _update;
	this.getActiveEditor = _getActiveEditor;
	
	this.onLoad = function () {
		if (!Zotero) {
			return;
		}

		_tabCover = document.getElementById('zotero-tab-cover');
		_itemToggle = document.getElementById('zotero-tb-toggle-item-pane');
		_notesToggle = document.getElementById('zotero-tb-toggle-notes-pane');
		_contextPane = document.getElementById('zotero-context-pane');
		_contextPaneInner = document.getElementById('zotero-context-pane-inner');
		_contextPaneSplitter = document.getElementById('zotero-context-splitter');
		_contextPaneSplitterStacked = document.getElementById('zotero-context-splitter-stacked');
		
		_splitButton = document.getElementById('zotero-tb-split');
		_itemPaneToggle = document.getElementById('zotero-tb-toggle-item-pane');
		_notesPaneToggle = document.getElementById('zotero-tb-toggle-notes-pane');
		_tabToolbar = document.getElementById('zotero-tab-toolbar');
		
		if (Zotero.rtl) {
			_tabToolbar.style.left = 0;
			_splitButton.style.transform = 'scaleX(-1)';
		}
		else {
			_tabToolbar.style.right = 0;
		}

		_init();

		this._notifierID = Zotero.Notifier.registerObserver(this, ['item', 'tab'], 'contextPane');
		window.addEventListener('resize', _update);
		_itemToggle.addEventListener('click', _toggleItemButton);
		_notesToggle.addEventListener('click', _toggleNotesButton);
		Zotero.Reader.onChangeSidebarWidth = _updatePaneWidth;
		Zotero.Reader.onChangeSidebarOpen = _updatePaneWidth;
	};

	this.onUnload = function () {
		_itemToggle.removeEventListener('click', _toggleItemButton);
		_notesToggle.removeEventListener('click', _toggleNotesButton);
		window.removeEventListener('resize', _update);
		Zotero.Notifier.unregisterObserver(this._notifierID);
		Zotero.Reader.onChangeSidebarWidth = () => {};
		Zotero.Reader.onChangeSidebarOpen = () => {};
		_contextPaneInner.innerHTML = '';
		_itemContexts = [];
		_notesContexts = [];
	};

	this.notify = Zotero.Promise.coroutine(function* (action, type, ids, extraData) {
		if (type == 'item') {
			// Update, remove or re-create item panes
			for (let context of _itemContexts.slice()) {
				let item = Zotero.Items.get(context.itemID);
				if (!item) {
					_removeItemContext(context.tabID);
				}
				else if (item.parentID != context.parentID) {
					_removeItemContext(context.tabID);
					_addItemContext(context.tabID, context.itemID);
				}
				else {
					context.update();
				}
			}
			
			// Update notes lists for affected libraries
			let libraryIDs = [];
			for (let id of ids) {
				let item = Zotero.Items.get(id);
				if (item && (item.isNote() || item.isRegularItem())) {
					libraryIDs.push(item.libraryID);
				}
				else if (action == 'delete') {
					libraryIDs.push(extraData[id].libraryID);
				}
			}
			for (let context of _notesContexts) {
				if (libraryIDs.includes(context.libraryID)) {
					context.affectedIDs = new Set([...context.affectedIDs, ...ids]);
					context.update();
				}
			}
		}
		else if (type == 'tab') {
			if (action == 'add') {
				_addItemContext(ids[0], extraData[ids[0]].itemID);
			}
			else if (action == 'close') {
				_removeItemContext(ids[0]);
				if (Zotero_Tabs.deck.children.length == 1) {
					_notesContexts.forEach(x => x.notesListRef.current.setExpanded(false));
				}
			}
			else if (action == 'select') {
				// It seems that changing `hidden` or `collapsed` values might
				// be related with significant slow down when there are too many
				// DOM nodes (i.e. 10k notes)
				if (Zotero_Tabs.selectedIndex == 0) {
					_contextPaneSplitter.setAttribute('hidden', true);
					_contextPane.setAttribute('collapsed', true);
					_tabToolbar.hidden = true;
					_tabCover.hidden = true;
				}
				else {
					var reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
					if (reader) {
						_tabCover.hidden = false;
						(async () => {
							await reader._initPromise;
							_tabCover.hidden = true;
							// Focus reader pages view if context pane note editor is not selected
							if (Zotero_Tabs.selectedID == reader.tabID
								&& (!document.activeElement
									|| !document.activeElement.closest('.context-node iframe[anonid="editor-view"]'))) {
								reader.focus();
							}
						})();

						var attachment = Zotero.Items.get(reader.itemID);
						if (attachment) {
							_selectNotesContext(attachment.libraryID);
							var notesContext = _getNotesContext(attachment.libraryID);
							notesContext.updateFromCache();
						}
					}
				
					_contextPaneSplitter.setAttribute('hidden', false);
					_contextPane.setAttribute('collapsed', !(_contextPaneSplitter.getAttribute('state') != 'collapsed'));
					_tabToolbar.hidden = false;
				}
				
				_selectItemContext(ids[0]);
				_update();
			}
		}
	});

	function _toggleItemButton() {
		_togglePane(0);
	}

	function _toggleNotesButton() {
		_togglePane(1);
	}
	
	function _getActiveEditor() {
		var splitter;
		if (Zotero.Prefs.get('layout') == 'stacked') {
			splitter = _contextPaneSplitterStacked;
		}
		else {
			splitter = _contextPaneSplitter;
		}

		if (splitter.getAttribute('state') != 'collapsed') {
			if (_panesDeck.selectedIndex == 1) {
				var node = _notesPaneDeck.selectedPanel;
				if (node.selectedIndex == 1) {
					return node.querySelector('zoteronoteeditor');
				}
			}
		}
	}

	function _updateAddToNote() {
		var reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
		if (reader) {
			var editor = _getActiveEditor();
			reader.enableAddToNote(!!editor);
		}
	}
	
	function _updatePaneWidth() {
		var stacked = Zotero.Prefs.get('layout') == 'stacked';
		var width = Zotero.Reader.getSidebarWidth() + 'px';
		if (!Zotero.Reader.getSidebarOpen()) {
			width = 0;
		}
		if (Zotero.rtl) {
			_contextPane.style.left = 0;
			_contextPane.style.right = stacked ? width : 'unset';
		}
		else {
			_contextPane.style.left = stacked ? width : 'unset';
			_contextPane.style.right = 0;
		}
	}

	function _updateToolbarWidth() {
		var stacked = Zotero.Prefs.get('layout') == 'stacked';
		var reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
		if (reader) {
			if ((stacked || _contextPaneSplitter.getAttribute('state') == 'collapsed')) {
				reader.setToolbarPlaceholderWidth(_tabToolbar.boxObject.width);
			}
			else {
				reader.setToolbarPlaceholderWidth(0);
			}
		}
	}

	function _update() {
		if (Zotero_Tabs.selectedIndex == 0) {
			return;
		}
	
		var splitter;
		var stacked = Zotero.Prefs.get('layout') == 'stacked';
		if (stacked) {
			_contextPaneSplitterStacked.setAttribute('hidden', false);
			_contextPaneSplitter.setAttribute('state', 'open');
			_contextPaneSplitter.setAttribute('hidden', true);
			_contextPane.classList.add('stacked');
			_contextPane.classList.remove('standard');
			splitter = _contextPaneSplitterStacked;
		}
		else {
			_contextPaneSplitter.setAttribute('hidden', false);
			_contextPaneSplitterStacked.setAttribute('hidden', true);
			_contextPaneSplitterStacked.setAttribute('state', 'open');
			_contextPane.classList.add('standard');
			_contextPane.classList.remove('stacked');
			splitter = _contextPaneSplitter;
		}
		
		var collapsed = splitter.getAttribute('state') == 'collapsed';
		
		var selectedIndex = _panesDeck.selectedIndex;
		if (!collapsed && selectedIndex == 0) {
			_itemPaneToggle.classList.add('toggled');
		}
		else {
			_itemPaneToggle.classList.remove('toggled');
		}

		if (!collapsed && selectedIndex == 1) {
			_notesPaneToggle.classList.add('toggled');
		}
		else {
			_notesPaneToggle.classList.remove('toggled');
		}
		
		if (Zotero_Tabs.selectedIndex > 0) {
			var height = 0;
			if (Zotero.Prefs.get('layout') == 'stacked'
				&& _contextPane.getAttribute('collapsed') != 'true') {
				height = _contextPaneInner.boxObject.height;
			}
			Zotero.Reader.setBottomPlaceholderHeight(height);
		}
		
		_updatePaneWidth();
		_updateToolbarWidth();
		_updateAddToNote();
	}

	function _togglePane(paneIndex) {
		var splitter = Zotero.Prefs.get('layout') == 'stacked'
			? _contextPaneSplitterStacked : _contextPaneSplitter;

		var isOpen = splitter.getAttribute('state') != 'collapsed';
		var hide = false;
		var currentPane = _panesDeck.selectedIndex;
		if (isOpen && currentPane == paneIndex) {
			hide = true;
		}
		else {
			_panesDeck.setAttribute('selectedIndex', paneIndex);
		}
		
		splitter.setAttribute('state', hide ? 'collapsed' : 'open');
		_update();
	}

	function _init() {
		// vbox
		var vbox = document.createElement('vbox');
		vbox.setAttribute('flex', '1');

		_contextPaneInner.append(vbox);

		// Toolbar extension
		var toolbarExtension = document.createElement('box');
		toolbarExtension.style.height = '32px';
		toolbarExtension.id = 'zotero-context-toolbar-extension';
		
		_panesDeck = document.createElement('deck');
		_panesDeck.setAttribute('flex', 1);
		_panesDeck.setAttribute('selectedIndex', 0);

		vbox.append(toolbarExtension, _panesDeck);

		// Item pane deck
		_itemPaneDeck = document.createElement('deck');
		// Notes pane deck
		_notesPaneDeck = document.createElement('deck');
		_notesPaneDeck.style.backgroundColor = 'white';
		_notesPaneDeck.setAttribute('flex', 1);
		_notesPaneDeck.className = 'notes-pane-deck';

		_panesDeck.append(_itemPaneDeck, _notesPaneDeck);
	}
	
	function _getCurrentAttachment() {
		var reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
		if (reader) {
			return Zotero.Items.get(reader.itemID);
		}
	}
	
	function _addNotesContext(libraryID) {
		var list = document.createElement('vbox');
		list.setAttribute('flex', 1);
		list.className = 'zotero-context-notes-list';

		var noteContainer = document.createElement('vbox');
		var title = document.createElement('vbox');
		title.className = 'zotero-context-pane-editor-parent-line';
		var editor = document.createElement('zoteronoteeditor');
		editor.className = 'zotero-context-pane-pinned-note';
		editor.setAttribute('flex', 1);
		noteContainer.append(title, editor);
		
		let contextNode = document.createElement('deck');
		contextNode.append(list, noteContainer);
		_notesPaneDeck.append(contextNode);
		
		contextNode.className = 'context-node';
		contextNode.setAttribute('selectedIndex', 0);
		
		editor.returnHandler = () => {
			contextNode.setAttribute('selectedIndex', 0);
			_updateAddToNote();
		};
		
		var head = document.createElement('hbox');
		head.style.display = 'flex';
		
		async function _createNoteFromAnnotations(child) {
			var attachment = _getCurrentAttachment();
			if (!attachment) {
				return;
			}
			var note = await Zotero.EditorInstance.createNoteFromAnnotations(
				attachment.getAnnotations(), child && attachment.parentID
			);

			_updateAddToNote();

			input.value = '';
			_updateNotesList();

			_setPinnedNote(note.id);
		}

		function _createNote(child) {
			contextNode.setAttribute('selectedIndex', 1);
			var item = new Zotero.Item('note');
			item.libraryID = libraryID;
			if (child) {
				var attachment = _getCurrentAttachment();
				if (!attachment) {
					return;
				}
				item.parentID = attachment.parentID;
			}
			editor.mode = 'edit';
			editor.item = item;
			editor.parentItem = null;
			editor.focus();
			_updateAddToNote();
			
			input.value = '';
			_updateNotesList();
		}

		var vbox = document.createElement('vbox');
		vbox.style.flex = '1';
		var input = document.createElement('textbox');
		input.style.width = 'calc(100% - 42px)';
		input.style.marginLeft = '12px';
		input.setAttribute('type', 'search');
		input.setAttribute('timeout', '250');
		input.addEventListener('command', () => {
			notesListRef.current.setExpanded(false);
			_updateNotesList();
		});
		vbox.append(input);
		
		head.append(vbox);

		var listBox = document.createElement('vbox');
		listBox.style.display = 'flex';
		listBox.setAttribute('flex', '1');
		var listInner = document.createElementNS(HTML_NS, 'div');
		listInner.className = 'notes-list-container';
		listBox.append(listInner);

		list.append(head, listBox);

		var notesListRef = React.createRef();

		function _isVisible() {
			let splitter = Zotero.Prefs.get('layout') == 'stacked'
				? _contextPaneSplitterStacked : _contextPaneSplitter;
			
			return Zotero_Tabs.selectedID != 'zotero-pane'
				&& _panesDeck.selectedIndex == 1
				&& context.node.selectedIndex == 0
				&& splitter.getAttribute('state') != 'collapsed';
		}

		async function _updateNotesList(useCached) {
			var query = input.value;
			var notes;
			
			// Calls itself and debounces until notes list becomes
			// visible, and then updates
			if (!useCached && !_isVisible()) {
				context.update();
				return;
			}
			
			if (useCached && context.cachedNotes.length) {
				notes = context.cachedNotes;
			}
			else {
				await Zotero.Schema.schemaUpdatePromise;
				var s = new Zotero.Search();
				s.addCondition('libraryID', 'is', libraryID);
				s.addCondition('itemType', 'is', 'note');
				if (query) {
					let parts = Zotero.SearchConditions.parseSearchString(query);
					for (let part of parts) {
						s.addCondition('note', 'contains', part.text);
					}
				}
				notes = await s.search();
				notes = Zotero.Items.get(notes);
				notes.sort((a, b) => {
					a = a.dateModified;
					b = b.dateModified;
					return (a > b ? -1 : (a < b ? 1 : 0));
				});
				
				let cachedNotesIndex = new Map();
				for (let cachedNote of context.cachedNotes) {
					cachedNotesIndex.set(cachedNote.id, cachedNote);
				}
				notes = notes.map(note => {
					var parentItem = note.parentItem;
					// If neither note nor parent item is affected try to return the cached note
					if (!context.affectedIDs.has(note.id)
						&& (!parentItem || !context.affectedIDs.has(parentItem.id))) {
						let cachedNote = cachedNotesIndex.get(note.id);
						if (cachedNote) {
							return cachedNote;
						}
					}
					var text = note.note;
					text = Zotero.Utilities.unescapeHTML(text);
					text = text.trim();
					text = text.slice(0, 500);
					var parts = text.split('\n').map(x => x.trim()).filter(x => x.length);
					var title = parts[0] && parts[0].slice(0, Zotero.Notes.MAX_TITLE_LENGTH);
					var date = Zotero.Date.sqlToDate(note.dateModified, true);
					date = Zotero.Date.toFriendlyDate(date);
					
					return {
						id: note.id,
						title: title || Zotero.getString('pane.item.notes.untitled'),
						body: parts[1] || '',
						date,
						parentID: note.parentID,
						parentItemType: parentItem && parentItem.itemType,
						parentTitle: parentItem && parentItem.getDisplayTitle()
					};
				});
				context.cachedNotes = notes;
			}
			context.affectedIDs = new Set();

			var attachment = _getCurrentAttachment();
			var parentID = attachment && attachment.parentID;
			notesListRef.current.setHasParent(!!parentID);
			notesListRef.current.setNotes(notes.map(note => ({
				...note,
				isCurrentChild: parentID && note.parentID == parentID
			})));
		}

		var context = {
			libraryID,
			node: contextNode,
			editor,
			notesListRef,
			cachedNotes: [],
			affectedIDs: new Set(),
			update: Zotero.Utilities.throttle(_updateNotesList, 1000, { leading: false }),
			updateFromCache: () => _updateNotesList(true)
		};
		
		function _handleListPopupClick(id, event) {
			switch (event.originalTarget.id) {
				case 'context-pane-list-show-in-library':
					ZoteroPane_Local.selectItem(id);
					Zotero_Tabs.select('zotero-pane');
					break;

				case 'context-pane-list-edit-in-window':
					ZoteroPane_Local.openNoteWindow(id);
					break;

				case 'context-pane-list-move-to-trash':
					Zotero.Items.trashTx(id);
					context.cachedNotes = context.cachedNotes.filter(x => x.id != id);
					_updateNotesList(true);
					break;

				default:
			}
		}
		
		function _handleAddChildNotePopupClick(event) {
			switch (event.originalTarget.id) {
				case 'context-pane-add-child-note':
					_createNote(true);
					break;

				case 'context-pane-add-child-note-from-annotations':
					_createNoteFromAnnotations(true);
					break;

				default:
			}
		}
		
		function _handleAddStandaloneNotePopupClick(event) {
			switch (event.originalTarget.id) {
				case 'context-pane-add-standalone-note':
					_createNote();
					break;

				case 'context-pane-add-standalone-note-from-annotations':
					_createNoteFromAnnotations();
					break;

				default:
			}
		}

		ReactDOM.render(
			<NotesList
				ref={notesListRef}
				onClick={(id) => {
					_setPinnedNote(id);
				}}
				onContextMenu={(id, event) => {
					var popup = document.getElementById('context-pane-list-popup');
					popup.onclick = (event) => _handleListPopupClick(id, event);
					popup.openPopupAtScreen(event.screenX, event.screenY);
				}}
				onAddChildButtonDown={(event) => {
					var popup = document.getElementById('context-pane-add-child-note-button-popup');
					popup.onclick = _handleAddChildNotePopupClick;
					popup.openPopup(event.target, 'after_end');
				}}
				onAddStandaloneButtonDown={(event) => {
					var popup = document.getElementById('context-pane-add-standalone-note-button-popup');
					popup.onclick = _handleAddStandaloneNotePopupClick;
					popup.openPopup(event.target, 'after_end');
				}}
			/>,
			listInner,
			() => {
				_updateNotesList();
			}
		);
		_notesContexts.push(context);
		return context;
	}
	
	function _getNotesContext(libraryID) {
		var context = _notesContexts.find(x => x.libraryID == libraryID);
		if (!context) {
			context = _addNotesContext(libraryID);
		}
		return context;
	}
	
	function _selectNotesContext(libraryID) {
		let context = _getNotesContext(libraryID);
		_notesPaneDeck.setAttribute('selectedIndex', Array.from(_notesPaneDeck.children).findIndex(x => x == context.node));
	}
	
	function _removeNotesContext(libraryID) {
		var context = _notesContexts.find(x => x.libraryID == libraryID);
		context.node.remove();
		_notesContexts = _notesContexts.filter(x => x.libraryID != libraryID);
	}
	
	function _isLibraryEditable(libraryID) {
		var type = Zotero.Libraries.get(libraryID).libraryType;
		if (type == 'group') {
			var groupID = Zotero.Groups.getGroupIDFromLibraryID(libraryID);
			var group = Zotero.Groups.get(groupID);
			return group.editable;
		}
		return true;
	}

	function _setPinnedNote(itemID) {
		var item = Zotero.Items.get(itemID);
		if (!item) {
			return;
		}
		var editable = _isLibraryEditable(item.libraryID);
		var context = _getNotesContext(item.libraryID);
		if (context) {
			var { editor, node } = context;
			node.setAttribute('selectedIndex', 1);
			editor.mode = editable ? 'edit' : 'view';
			editor.item = item;
			editor.parentItem = null;
			
			node.querySelector('.zotero-context-pane-editor-parent-line').innerHTML = '';
			var parentItem = item.parentItem;
			if (parentItem) {
				var container = document.createElementNS(HTML_NS, 'div');
				var img = document.createElementNS(HTML_NS, 'img');
				img.src = Zotero.ItemTypes.getImageSrc(parentItem.itemType);
				img.className = 'parent-item-type';
				var title = document.createElementNS(HTML_NS, 'div');
				title.append(parentItem.getDisplayTitle());
				title.className = 'parent-title';
				container.append(img, title);
				node.querySelector('.zotero-context-pane-editor-parent-line').append(container);
			}
			_updateAddToNote();
		}
	}

	function _removeItemContext(tabID) {
		document.getElementById(tabID + '-context').remove();
		_itemContexts = _itemContexts.filter(x => x.tabID != tabID);
	}

	function _selectItemContext(tabID) {
		let selectedIndex = Array.from(_itemPaneDeck.children).findIndex(x => x.id == tabID + '-context');
		if (selectedIndex != -1) {
			_itemPaneDeck.setAttribute('selectedIndex', selectedIndex);
		}
	}

	function _addItemContext(tabID, itemID) {
		var item = Zotero.Items.get(itemID);
		if (!item) {
			return;
		}
		var libraryID = item.libraryID;
		var editable = _isLibraryEditable(libraryID);
		var parentID = item.parentID;
	
		var container = document.createElement('vbox');
		container.id = tabID + '-context';
		container.className = 'zotero-item-pane-content';
		_itemPaneDeck.appendChild(container);
		
		var context = {
			tabID,
			itemID,
			parentID,
			libraryID,
			update: () => {}
		};
		_itemContexts.push(context);
		
		if (!parentID) {
			var vbox = document.createElement('vbox');
			vbox.setAttribute('flex', '1');
			vbox.setAttribute('align', 'center');
			vbox.setAttribute('pack', 'center');
			var description = document.createElement('description');
			vbox.append(description);
			description.append(Zotero.getString('pane.context.noParent'));
			container.append(vbox);
			return;
		}
		var parentItem = Zotero.Items.get(item.parentID);

		// tabbox
		var tabbox = document.createElement('tabbox');
		tabbox.setAttribute('flex', '1');
		tabbox.className = 'zotero-view-tabbox';

		container.append(tabbox);

		// tabs
		var tabs = document.createElement('tabs');
		tabs.className = 'zotero-editpane-tabs';
		// tabpanels
		var tabpanels = document.createElement('tabpanels');
		tabpanels.setAttribute('flex', '1');
		tabpanels.className = 'zotero-view-item';
		tabpanels.addEventListener('select', () => {
			_updateAddToNote();
		});

		tabbox.append(tabs, tabpanels);

		// Info tab
		var tabInfo = document.createElement('tab');
		tabInfo.setAttribute('label', Zotero.Intl.strings['zotero.tabs.info.label']);
		// Tags tab
		var tabTags = document.createElement('tab');
		tabTags.setAttribute('label', Zotero.Intl.strings['zotero.tabs.tags.label']);
		// Related tab
		var tabRelated = document.createElement('tab');
		tabRelated.setAttribute('label', Zotero.Intl.strings['zotero.tabs.related.label']);

		tabs.append(tabInfo, tabTags, tabRelated);

		// Info panel
		var panelInfo = document.createElement('tabpanel');
		panelInfo.setAttribute('flex', '1');
		panelInfo.className = 'zotero-editpane-item-box';
		var itemBox = document.createElement('zoteroitembox');
		itemBox.setAttribute('flex', '1');
		panelInfo.append(itemBox);
		// Notes panel
		var panelNotes = document.createElement('tabpanel');
		panelNotes.setAttribute('flex', '1');
		panelNotes.setAttribute('orient', 'vertical');
		var deck = document.createElement('deck');
		deck.className = 'notes-deck';
		deck.setAttribute('flex', '1');
		panelNotes.append(deck);
		var vbox2 = document.createElement('vbox');
		var note = document.createElement('zoteronoteeditor');
		note.setAttribute('flex', 1);
		vbox2.append(note);
		var vbox = document.createElement('vbox');
		vbox.setAttribute('flex', '1');
		vbox.setAttribute('class', 'zotero-box');
		vbox.style.overflowY = 'auto';
		panelNotes.append(vbox);
		var hbox = document.createElement('hbox');
		hbox.setAttribute('align', 'center');
		var label = document.createElement('label');
		var button = document.createElement('button');
		button.hidden = !editable;
		button.setAttribute('label', Zotero.Intl.strings['zotero.item.add']);
		button.addEventListener('click', () => {
			deck.setAttribute('selectedIndex', 1);
			var item = new Zotero.Item('note');
			item.libraryID = parentItem.libraryID;
			item.parentID = parentItem.id;
			note.returnHandler = () => {
				deck.setAttribute('selectedIndex', 0);
				_updateAddToNote();
			};
			note.mode = editable ? 'edit' : 'view';
			note.item = item;
			note.focus();
			_updateAddToNote();
		});
		hbox.append(label, button);
		var grid = document.createElement('grid');
		grid.setAttribute('flex', 1);
		var columns = document.createElement('columns');
		var column = document.createElement('column');
		column.setAttribute('flex', 1);
		columns.append(column);
		var column = document.createElement('column');
		columns.append(column);
		grid.append(columns);
		var rows = document.createElement('rows');
		rows.setAttribute('flex', 1);
		grid.append(rows);
		vbox.append(hbox, grid);
		deck.append(vbox, vbox2);
		deck.setAttribute('selectedIndex', 0);
		// Tags panel
		var panelTags = document.createElement('tabpanel');
		panelTags.setAttribute('orient', 'vertical');
		panelTags.setAttribute('context', 'tags-context-menu');
		panelTags.className = 'tags-pane';
		panelTags.style.display = 'flex';
		var div = document.createElementNS(HTML_NS, 'div');
		div.className = 'tags-box-container';
		div.style.display = 'flex';
		div.style.flexGrow = '1';
		panelTags.append(div);
		var tagsBoxRef = React.createRef();
		ReactDOM.render(
			<TagsBoxContainer
				key={'tagsBox-' + parentItem.id}
				item={parentItem}
				editable={editable}
				ref={tagsBoxRef}
			/>,
			div
		);
		// Related panel
		var panelRelated = document.createElement('tabpanel');
		var relatedBox = document.createElement('relatedbox');
		relatedBox.setAttribute('flex', '1');
		relatedBox.className = 'zotero-editpane-related';
		panelRelated.addEventListener('click', (event) => {
			if (event.originalTarget.closest('.zotero-clicky')) {
				Zotero_Tabs.select('zotero-pane');
			}
		});
		panelRelated.append(relatedBox);

		tabpanels.append(panelInfo, panelTags, panelRelated);
		tabbox.selectedIndex = 0;


		itemBox.mode = editable ? 'edit' : 'view';
		itemBox.item = parentItem;

		relatedBox.mode = editable ? 'edit' : 'view';
		relatedBox.item = parentItem;
	}
};

addEventListener('load', function (e) { ZoteroContextPane.onLoad(e); }, false);
addEventListener('unload', function (e) { ZoteroContextPane.onUnload(e); }, false);
