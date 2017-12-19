/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2009 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
                     http://zotero.org
    
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

Zotero.RecognizePDF = new function () {
	const OFFLINE_CHECK_DELAY = 60 * 1000;
	
	this.ROW_QUEUED = 1;
	this.ROW_PROCESSING = 2;
	this.ROW_FAILED = 3;
	this.ROW_SUCCEEDED = 4;
	
	this.getRows = getRows;
	this.getTotal = getTotal;
	this.getProcessed = getProcessed;
	this.cancel = cancel;
	this.canRecognize = canRecognize;
	this.recognizeItems = recognizeItems;
	this.addListener = addListener;
	this.removeListener = removeListener;
	
	let _listeners = {};
	let _rows = [];
	let _queue = [];
	let _queueProcessing = false;
	
	function addListener(name, callback) {
		_listeners[name] = callback;
	}
	
	function removeListener(name) {
		delete _listeners[name];
	}
	
	/**
	 * Checks whether a given PDF could theoretically be recognized
	 * @returns {Boolean} True if the PDF can be recognized, false if it cannot be
	 */
	function canRecognize(/**Zotero.Item*/ item) {
		return item.attachmentMIMEType
			&& item.attachmentMIMEType === 'application/pdf'
			&& item.isTopLevelItem();
	}
	
	/**
	 * Retrieves metadata for the PDF(s) selected in the Zotero Pane, placing the PDFs as a children
	 * of the new items
	 */
	function recognizeItems(items) {
		for (let i = 0; i < items.length; i++) {
			_addItem(items[i]);
		}
		_processQueue();
	}
	
	function getRows() {
		return _rows;
	}
	
	function getTotal() {
		return _rows.length;
	}
	
	function getProcessed() {
		let processed = 0;
		for (let i = 0; i < _rows.length; i++) {
			let row = _rows[i];
			if (row.status > Zotero.RecognizePDF.ROW_PROCESSING) {
				processed++;
			}
		}
		return processed;
	}
	
	function cancel() {
		_queue = [];
		_rows = [];
		if (_listeners['onEmpty']) {
			_listeners['onEmpty']();
		}
	}
	
	function _addItem(item) {
		for (let i = 0; i < _rows.length; i++) {
			let row = _rows[i];
			if (row.id === item.id) {
				if (row.status > Zotero.RecognizePDF.ROW_PROCESSING) {
					_deleteRow(row.id);
					break;
				}
				return null;
			}
		}
		
		let row = {
			id: item.id,
			status: Zotero.RecognizePDF.ROW_QUEUED,
			fileName: item.getField('title'),
			message: ''
		};
		
		_rows.push(row);
		_queue.push(item.id);
		
		if (_listeners['onRowAdded']) {
			_listeners['onRowAdded'](row);
		}
		
		if (_listeners['onNonEmpty'] && _rows.length === 1) {
			_listeners['onNonEmpty']();
		}
	}
	
	function _updateRow(itemID, status, message) {
		for (let i = 0; i < _rows.length; i++) {
			let row = _rows[i];
			if (row.id === itemID) {
				row.status = status;
				row.message = message;
				if (_listeners['onRowUpdated']) {
					_listeners['onRowUpdated']({
						id: row.id,
						status,
						message: message || ''
					});
				}
				return;
			}
		}
	}
	
	function _deleteRow(itemID) {
		for (let i = 0; i < _rows.length; i++) {
			let row = _rows[i];
			if (row.id === itemID) {
				_rows.splice(i, 1);
				if (_listeners['onRowDeleted']) {
					_listeners['onRowDeleted']({
						id: row.id
					});
				}
				return;
			}
		}
	}
	
	async function _processQueue() {
		await Zotero.Schema.schemaUpdatePromise;
		
		if (_queueProcessing) return;
		_queueProcessing = true;
		
		while (1) {
			if (Zotero.HTTP.browserIsOffline()) {
				await Zotero.Promise.delay(OFFLINE_CHECK_DELAY);
				continue;
			}
			
			let itemID = _queue.shift();
			if (!itemID) break;
			
			_updateRow(itemID, Zotero.RecognizePDF.ROW_PROCESSING, 'processing');
			
			try {
				let newItem = await _processItem(itemID);
				
				if (newItem) {
					_updateRow(itemID, Zotero.RecognizePDF.ROW_SUCCEEDED, newItem.getField('title'));
				}
				else {
					_updateRow(itemID, Zotero.RecognizePDF.ROW_FAILED, Zotero.getString('recognizePDF.noMatches'));
				}
			}
			catch (e) {
				Zotero.logError(e);
				
				_updateRow(
					itemID,
					Zotero.RecognizePDF.ROW_FAILED,
					e instanceof Zotero.Exception.Alert
						? e.message
						: Zotero.getString('recognizePDF.error')
				);
				
				_queue.push(itemID);
				await Zotero.Promise.delay(1000);
			}
		}
		
		_queueProcessing = false;
	}

	async function _processItem(itemID) {
		let item = await Zotero.Items.getAsync(itemID);
		
		if (!item) throw new Zotero.Exception.Alert('recognizePDF.fileNotFound');
		
		if (item.parentItemID) throw new Zotero.Exception.Alert('recognizePDF.fileNotFound');
		
		let newItem = await _recognize(item);
		
		if (newItem) {
			// put new item in same collections as the old one
			let itemCollections = item.getCollections();
			await Zotero.DB.executeTransaction(async function () {
				for (let i = 0; i < itemCollections.length; i++) {
					let collection = Zotero.Collections.get(itemCollections[i]);
					await collection.addItem(newItem.id);
				}
				
				// put old item as a child of the new item
				item.parentID = newItem.id;
				await item.save();
			});
			
			return newItem
		}
		
		return null;
	}
	
	/**
	 * Retrieves metadata for a PDF and saves it as an item
	 *
	 * @param {Zotero.Item} item
	 * @return {Promise} A promise resolved when PDF metadata has been retrieved
	 */
	async function _recognize(item) {
		
		let file = item.getFile();
		
		let hash = await item.attachmentHash;
		let fulltext = await _extractText(file, 5);
		
		let libraryID = item.libraryID;
		
		// Look for DOI - Use only first two pages
		let allText = fulltext;
		
		let newItem;
		
		
		newItem = await _recognizerServer.findItem(fulltext, hash, libraryID);
		if (newItem) return newItem;
		
		return null;
	}
	
	/**
	 * Get text from a PDF
	 * @param {nsIFile} file PDF
	 * @param {Number} pages Number of pages to extract
	 * @return {Promise}
	 */
	function _extractText(file, pages) {
		var cacheFile = Zotero.File.pathToFile(Zotero.DataDirectory.dir);
		cacheFile.append("recognizePDFcache.txt");
		if (cacheFile.exists()) {
			cacheFile.remove(false);
		}
		
		var {exec, args} = Zotero.Fulltext.getPDFConverterExecAndArgs();
		args.push('-enc', 'UTF-8', '-bbox-layout', '-l', pages, file.path, cacheFile.path);
		
		Zotero.debug("RecognizePDF: Running " + exec.path + " " + args.map(arg => "'" + arg + "'").join(" "));
		
		return Zotero.Utilities.Internal.exec(exec, args).then(function () {
			if (!cacheFile.exists()) {
				throw new Zotero.Exception.Alert("recognizePDF.couldNotRead");
			}
			
			try {
				var inputStream = Components.classes["@mozilla.org/network/file-input-stream;1"]
					.createInstance(Components.interfaces.nsIFileInputStream);
				inputStream.init(cacheFile, 0x01, 0o664, 0);
				try {
					var intlStream = Components.classes["@mozilla.org/intl/converter-input-stream;1"]
						.createInstance(Components.interfaces.nsIConverterInputStream);
					intlStream.init(inputStream, "UTF-8", 65535,
						Components.interfaces.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
					intlStream.QueryInterface(Components.interfaces.nsIUnicharLineInputStream);
					
					let str = {};
					let data = '';
					let read = 0;
					do {
						read = intlStream.readString(0xffffffff, str); // read as much as we can and put it in str.value
						data += str.value;
					}
					while (read != 0);
					
					Zotero.debug(data);
					return data;
				}
				finally {
					inputStream.close();
				}
			}
			finally {
				cacheFile.remove(false);
			}
			
			return lines;
		}, function () {
			throw new Zotero.Exception.Alert("recognizePDF.couldNotRead");
		});
	}
	
	/**
	 * Attach appropriate handlers to a Zotero.Translate instance and begin translation
	 * @return {Promise}
	 */
	async function _promiseTranslate(translate, libraryID) {
		translate.setHandler('select', function (translate, items, callback) {
			for (let i in items) {
				let obj = {};
				obj[i] = items[i];
				callback(obj);
				return;
			}
		});
		
		let newItems = await translate.translate({
			libraryID,
			saveAttachments: false
		});
		if (newItems.length) {
			return newItems[0];
		}
		throw new Error('No items found');
	}
	
	let _recognizerServer = new function () {
		this.findItem = findItem;
		
		async function findItem(fulltext, hash, libraryID) {
			
			let res = await _query(hash, fulltext);
			if (!res) return null;
			
			if (res.doi) {
				Zotero.debug('RecognizePDF: Getting metadata by DOI');
				let translateDOI = new Zotero.Translate.Search();
				translateDOI.setTranslator('11645bd1-0420-45c1-badb-53fb41eeb753');
				translateDOI.setSearch({'itemType': 'journalArticle', 'DOI': res.doi});
				try {
					let newItem = await _promiseTranslate(translateDOI, libraryID);
					if (!newItem.abstractNote && res.abstract) {
						newItem.setField('abstractNote', res.abstract);
					}
					newItem.saveTx();
					return newItem;
				}
				catch (e) {
					Zotero.debug('RecognizePDF: ' + e);
				}
			}
			else if (res.isbn) {
				Zotero.debug('RecognizePDF: Getting metadata by ISBN');
				let translate = new Zotero.Translate.Search();
				translate.setSearch({'itemType': 'book', 'ISBN': res.isbn});
				try {
					let translatedItems = await translate.translate({
						libraryID: false,
						saveAttachments: false
					});
					Zotero.debug('RecognizePDF: Translated items:');
					Zotero.debug(translatedItems);
					if (translatedItems.length) {
						let newItem = new Zotero.Item;
						newItem.fromJSON(translatedItems[0]);
						newItem.libraryID = libraryID;
						if (!newItem.abstractNote && res.abstract) {
							newItem.setField('abstractNote', res.abstract);
						}
						newItem.saveTx();
						return newItem;
					}
					
				}
				catch (e) {
					Zotero.debug('RecognizePDF: ' + e);
				}
			}
			
			if (res.title) {
				
				let type = 'journalArticle';
				
				if(res.type=='book-chapter') {
					type = 'bookSection';
				}
				
				let newItem = new Zotero.Item(type);
				newItem.setField('title', res.title);
				
				let creators = [];
				for (let i = 0; i < res.authors.length; i++) {
					let author = res.authors[i];
					creators.push({
						firstName: author.firstName,
						lastName: author.lastName,
						creatorType: 'author'
					})
				}
				
				newItem.setCreators(creators);
				
				if (res.abstract) newItem.setField('abstractNote', res.abstract);
				if (res.year) newItem.setField('date', res.year);
				if (res.pages) newItem.setField('pages', res.pages);
				if (res.volume) newItem.setField('volume', res.volume);
				
				if(type=='journalArticle') {
					if (res.issue) newItem.setField('issue', res.issue);
					if (res.issn) newItem.setField('issn', res.issn);
					if (res.container) newItem.setField('publicationTitle', res.container);
				} else if(type=='bookSection') {
					if (res.container) newItem.setField('bookTitle', res.container);
				}
				
				newItem.setField('libraryCatalog', 'Zotero Metadata Service');
				
				await newItem.saveTx();
				return newItem;
			}
			
			return null;
		}
		
		async function _query(hash, fulltext) {
			let body = JSON.stringify({
				hash: hash,
				body: JSON.parse(fulltext)
			});
			
			let uri = 'http://62.210.116.165:8003/recognize';
			
			let req = await Zotero.HTTP.request(
				'POST',
				uri,
				{
					successCodes: [200],
					headers: {
						'Content-Type': 'application/json'
					},
					debug: true,
					body: body
				}
			);
			
			let json = JSON.parse(req.responseText);
			
			return json;
		}
		
		
	};
};
