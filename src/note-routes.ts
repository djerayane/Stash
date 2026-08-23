import { json, readJson, type HttpRoute } from "./http-routing.js";
import { InvalidNoteEdit, InvalidNoteInput, InvalidNoteTriageInput, presentNoteTriageResult, type NoteService } from "./notes.js";
import { noteEditorMotion } from "./note-editor-assets.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

export function noteRoutes(service: NoteService, memberAccess: MemberAccessResolver): HttpRoute {
  return {
    matches: (request, url) => (request.method === "POST" && /^\/api\/workspaces\/[^/]+\/notes$/.test(url.pathname))
      || (request.method === "GET" && /^\/api\/workspaces\/[^/]+\/note-templates$/.test(url.pathname))
      || (request.method === "GET" && /^\/api\/workspaces\/[^/]+\/notes$/.test(url.pathname) && url.searchParams.get("view") === "decisions")
      || (request.method === "GET" && /^\/api\/workspaces\/[^/]+\/inbox$/.test(url.pathname))
      || (request.method === "POST" && /^\/api\/workspaces\/[^/]+\/inbox\/[^/]+\/triage$/.test(url.pathname))
      || (request.method === "GET" && /^\/api\/notes\/[^/]+\/conflicts$/.test(url.pathname))
      || (request.method === "PUT" && /^\/api\/notes\/[^/]+\/conflicts\/[^/]+$/.test(url.pathname))
      || (["GET", "PUT"].includes(request.method ?? "") && /^\/api\/notes\/[^/]+$/.test(url.pathname)),
    async handle(request, response, url) {
      const access = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!access) {
        json(response, 401, { error: "unauthorized", message: "A valid Member session is required." });
        return true;
      }
      try {
        if (request.method === "GET" && /^\/api\/workspaces\/[^/]+\/(note-templates|notes)$/.test(url.pathname)) {
          let workspaceId: string;
          try { workspaceId = decodeURIComponent(url.pathname.split("/")[3]!); } catch { throw new InvalidNoteInput(); }
          const result = url.pathname.endsWith("/note-templates")
            ? await service.listTemplates(access.accountId, workspaceId)
            : await service.listDecisions(access.accountId, workspaceId);
          if (result.status === "workspace_forbidden") {
            json(response, 403, { error: "workspace_forbidden", message: "This Member cannot read Notes in that Workspace." });
          } else if ("templates" in result) json(response, 200, { templates: result.templates });
          else json(response, 200, { notes: result.notes.map(({ createdByMemberId: _, ...note }) => note) });
          return true;
        }
        if (request.method === "GET" && url.pathname.endsWith("/conflicts")) {
          let noteId: string;
          try { noteId = decodeURIComponent(url.pathname.split("/")[3]!); } catch { throw new InvalidNoteEdit(); }
          const result = await service.listConflicts(access.accountId, noteId);
          if (result.status === "not_found") json(response, 404, { error: "note_not_found", message: "This Note is unavailable." });
          else json(response, 200, { conflicts: result.conflicts });
          return true;
        }
        if (request.method === "PUT" && url.pathname.includes("/conflicts/")) {
          let noteId: string; let conflictId: string;
          try { noteId = decodeURIComponent(url.pathname.split("/")[3]!); conflictId = decodeURIComponent(url.pathname.split("/")[5]!); }
          catch { throw new InvalidNoteEdit(); }
          const result = await service.resolveConflict(access.accountId, noteId, conflictId, await readJson(request));
          if (result.status === "resolved") {
            const { createdByMemberId: _, ...note } = result.note;
            json(response, 200, { ...note, portableProjection: { format: result.projection.schema, state: "recorded" } });
          } else if (result.status === "already_resolved") json(response, 409, { error: "conflict_already_resolved", message: "This conflict has already been resolved." });
          else if (result.status === "conflict_changed") json(response, 409, { error: "conflict_changed", message: "The Note changed again. Review the refreshed conflict before resolving it.", conflict: result.conflict });
          else if (result.status === "invalid_operation_identity") json(response, 422, { error: "invalid_operation_identity", message: "This preserved edit reused an operation identity and cannot be applied safely." });
          else if (result.status === "invalid_reference") json(response, 422, { error: "invalid_block_reference", message: "The preserved contribution no longer has an unambiguous Block target." });
          else json(response, 404, { error: result.status, message: "The requested Note conflict could not be found." });
          return true;
        }
        if (request.method === "GET" && url.pathname.startsWith("/api/notes/")) {
          let noteId: string;
          try { noteId = decodeURIComponent(url.pathname.split("/")[3]!); } catch { throw new InvalidNoteEdit(); }
          const note = await service.get(access.accountId, noteId);
          if (!note) json(response, 404, { error: "note_not_found", message: "This Note is unavailable." });
          else { const { createdByMemberId: _, ...publicNote } = note; json(response, 200, publicNote); }
          return true;
        }
        if (request.method === "PUT" && url.pathname.startsWith("/api/notes/")) {
          let noteId: string;
          try { noteId = decodeURIComponent(url.pathname.split("/")[3]!); } catch { throw new InvalidNoteEdit(); }
          const result = await service.edit(access.accountId, noteId, await readJson(request));
          if (result.status === "updated" || result.status === "duplicate") {
            const { createdByMemberId: _, ...note } = result.note;
            json(response, 200, { ...note, portableProjection: { format: result.projection.schema, state: "recorded" } });
          } else if (result.status === "conflict_preserved") {
            json(response, 409, { error: "revision_conflict", message: "This Note changed since editing began. Your version was preserved for conflict resolution.",
              ...(result.conflictId ? { conflictId: result.conflictId } : {}) });
          } else if (result.status === "invalid_reference") {
            json(response, 422, { error: "invalid_block_reference", message: "A Block reference is missing or ambiguous. Reload the Note and repair it explicitly." });
          } else json(response, 404, { error: "note_not_found", message: "This Note is unavailable." });
          return true;
        }
        let workspaceId: string;
        try {
          workspaceId = decodeURIComponent(url.pathname.split("/")[3]!);
        } catch {
          throw new InvalidNoteInput();
        }
        if (request.method === "GET") {
          const result = await service.listInbox(access.accountId, workspaceId);
          if (result.status === "workspace_forbidden") json(response, 403, { error: "workspace_forbidden", message: "This Member cannot read that Workspace Inbox." });
          else json(response, 200, { notes: result.notes.map(({ createdByMemberId: _, ...note }) => note) });
          return true;
        }
        if (url.pathname.includes("/inbox/")) {
          let noteId: string;
          try { noteId = decodeURIComponent(url.pathname.split("/")[5]!); } catch { throw new InvalidNoteTriageInput(); }
          const outcome = await service.triage(access.accountId, workspaceId, noteId, await readJson(request));
          if (outcome.status === "updated") {
            json(response, 200, presentNoteTriageResult(outcome.result)); return true;
          }
          if (outcome.status === "note_not_found" || outcome.status === "target_note_not_found") {
            json(response, 404, { error: outcome.status, message: "The requested Note could not be found." }); return true;
          }
          json(response, 403, { error: "workspace_forbidden", message: "This Member cannot triage that Note or Project." }); return true;
        }
        const result = await service.capture(access.accountId, workspaceId, await readJson(request));
        if (result.status === "created") {
          const { createdByMemberId: _, ...note } = result.note;
          json(response, 201, {
            ...note,
            portableProjection: {
              format: result.projection.schema,
              state: "recorded",
            },
          });
        } else {
          json(response, 403, {
            error: "workspace_forbidden",
            message: "This Member cannot capture Notes in that Workspace or Project.",
          });
        }
      } catch (error) {
        if (error instanceof InvalidNoteEdit) {
          json(response, 422, { error: "invalid_rich_text", message: "The rich-text document is invalid and was not saved." });
        } else if (error instanceof InvalidNoteInput || error instanceof InvalidNoteTriageInput) {
          json(response, 422, {
            error: "invalid_input",
            message: "A Note requires content or a supported Template and valid optional Project, tags, and reminder fields.",
          });
        } else if (error instanceof SyntaxError || (error instanceof Error && error.message === "body_too_large")) {
          const tooLarge = error instanceof Error && error.message === "body_too_large";
          json(response, tooLarge ? 413 : 400, {
            error: tooLarge ? "body_too_large" : "invalid_json",
            message: tooLarge ? "Request body exceeds the 64 KiB limit." : "Request body must be valid JSON.",
          });
        } else {
          json(response, 503, {
            error: "note_unavailable",
            message: "The Note could not be captured. Try again.",
          });
        }
      }
      return true;
    },
  };
}

export function noteLibraryRoute(): HttpRoute {
  return {
    matches: (request, url) => request.method === "GET" && /^\/workspaces\/[0-9a-f-]+\/notes$/.test(url.pathname),
    async handle(_request, response) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notes · Stash</title><script src="/assets/gsap.min.js"></script><style>
      :root{font-family:Geist,system-ui,sans-serif;color:#17201b;background:#f3f1e9}*{box-sizing:border-box}body{margin:0}main{max-width:68rem;margin:auto;padding:clamp(1.25rem,5vw,4.5rem)}nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:clamp(3rem,8vw,7rem)}.brand{font-weight:780;letter-spacing:-.04em}.status{color:#566158}.intro{max-width:48rem}.intro h1{margin:0;font-size:clamp(2.6rem,7vw,5.6rem);line-height:.94;letter-spacing:-.065em}.intro p{max-width:38rem;margin:1.5rem 0 2rem;font-size:1.08rem;line-height:1.65;color:#566158}.composer{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.75rem;align-items:stretch}textarea{min-height:7.5rem;resize:vertical;border:1px solid #c9c4b7;border-radius:.7rem;padding:1rem;background:#fff;color:#17201b;font:1rem/1.55 Georgia,serif}button,a.note{border:0;border-radius:.55rem;font:700 .92rem Geist,system-ui,sans-serif}button{padding:.8rem 1rem;cursor:pointer}.actions{display:flex;flex-direction:column;gap:.5rem}.blank{background:#17201b;color:#fff}.decision{background:#d98b22;color:#17201b}.views{margin-top:clamp(5rem,10vw,9rem);border-top:1px solid #c9c4b7;padding-top:2rem}.views h2{font-size:clamp(1.75rem,4vw,3rem);letter-spacing:-.045em}.notes{display:grid;gap:.6rem}.note{display:block;padding:1rem 1.1rem;background:#fff;color:#17201b;text-decoration:none;border-left:3px solid #d98b22}.note small{display:block;margin-top:.35rem;color:#6d756f}button:hover,.note:hover{transform:translateY(-2px)}button:focus-visible,textarea:focus-visible,.note:focus-visible{outline:3px solid #9a6114;outline-offset:3px}.empty{color:#6d756f}@media(max-width:42rem){.composer{grid-template-columns:1fr}.actions{flex-direction:row}.actions button{flex:1}}@media(prefers-reduced-motion:no-preference){button,.note{transition:transform .2s ease,background .2s ease}}
      </style></head><body><main><nav><span class="brand">Stash</span><span class="status" role="status" aria-live="polite">Ready</span></nav><section class="intro"><h1>Start with a useful shape.</h1><p>Begin from a blank Note or use a lightweight template. Templates suggest structure; every result stays an ordinary, portable Note.</p><div class="composer"><label><span>Opening thought</span><textarea placeholder="Write a first thought, or leave empty when using the Decision template"></textarea></label><div class="actions"><button class="blank" type="button" data-template="blank">Blank Note</button><button class="decision" type="button" data-template="decision">Decision Note</button></div></div></section><section class="views"><h2>Decision Notes</h2><div class="notes" aria-live="polite"><p class="empty">Loading settled choices…</p></div></section><script>
      const workspaceId=location.pathname.split('/')[2],token=()=>localStorage.getItem('stash.memberToken')||'',status=document.querySelector('.status'),notes=document.querySelector('.notes'),text=document.querySelector('textarea');
      const announce=(message)=>status.textContent=message;
      const render=(items)=>{notes.replaceChildren();if(!items.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='No Decision Notes yet.';notes.append(empty);return}for(const note of items){const link=document.createElement('a');link.className='note';link.href='/notes/'+note.id+'/edit';link.textContent=note.content.split('\\n').find(line=>line.trim())?.replace(/^#+\\s*/, '')||'Untitled Decision';const date=document.createElement('small');date.textContent=new Date(note.createdAt).toLocaleDateString();link.append(date);notes.append(link)}};
      const refresh=async()=>{try{const response=await fetch('/api/workspaces/'+workspaceId+'/notes?view=decisions',{headers:{authorization:'Bearer '+token()}}),body=await response.json();if(!response.ok)throw new Error(body.message);render(body.notes)}catch(error){notes.replaceChildren();const empty=document.createElement('p');empty.className='empty';empty.textContent=error.message||'Decision Notes could not be loaded.';notes.append(empty)}};
      document.querySelectorAll('[data-template]').forEach(button=>button.addEventListener('click',async()=>{const templateId=button.dataset.template,content=text.value.trim();if(templateId==='blank'&&!content){announce('Write an opening thought first.');text.focus();return}announce('Creating Note…');button.disabled=true;try{const payload={...(content?{content}:{}),...(templateId==='decision'?{templateId}:{})};const response=await fetch('/api/workspaces/'+workspaceId+'/notes',{method:'POST',headers:{authorization:'Bearer '+token(),'content-type':'application/json'},body:JSON.stringify(payload)}),body=await response.json();if(!response.ok)throw new Error(body.message);location.href='/notes/'+body.id+'/edit'}catch(error){announce(error.message||'The Note could not be created.');button.disabled=false}}));refresh();
      </script></main></body></html>`);
      return true;
    },
  };
}

export function noteEditorRoute(): HttpRoute {
  return {
    matches: (request, url) => request.method === "GET" && /^\/notes\/[0-9a-f-]+\/edit$/.test(url.pathname),
    async handle(_request, response) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Edit Note · Stash</title><script src="/assets/gsap.min.js"></script><style>
      :root{font-family:Geist,system-ui,sans-serif;color:#17201b;background:#f3f1e9}body{margin:0}main{max-width:54rem;margin:auto;padding:clamp(1rem,5vw,4rem)}nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:2.5rem}.brand{font-weight:750;letter-spacing:-.03em}.toolbar{position:sticky;top:1rem;display:flex;flex-wrap:wrap;gap:.35rem;padding:.5rem;background:#17201b;border-radius:.75rem}button{border:0;border-radius:.45rem;padding:.62rem .8rem;color:#fff;background:transparent;font:inherit;font-weight:650}button:hover,button:focus-visible{background:#34453b;outline:2px solid #e8a93f;outline-offset:2px}button:disabled{cursor:not-allowed;opacity:.45}#editor{min-height:26rem;margin-top:1rem;padding:clamp(1.2rem,4vw,3rem);background:#fff;border:1px solid #d7d3c7;border-radius:.75rem;font:1.1rem/1.75 Georgia,serif;box-shadow:0 1rem 4rem #17201b12}#editor:focus{outline:3px solid #b87818;outline-offset:3px}.status{min-height:1.5em;color:#566158}.save{background:#d98b22;color:#17201b;margin-left:auto}.task-links{display:flex;flex-wrap:wrap;gap:.4rem;margin:-.25rem 0 1rem;padding:.45rem .55rem;border-left:2px solid #b87818;background:#f7f2e7;font:600 .78rem/1.3 Geist,system-ui,sans-serif;color:#34453b}.task-link{display:inline-flex;gap:.45rem;align-items:center}.task-link-key{color:#86520d}.task-link-status{padding:.15rem .38rem;border-radius:.25rem;background:#17201b;color:#fff}.task-repair{margin:0 0 1rem;padding:.75rem .85rem;border-left:3px solid #9b3d2e;background:#fff0ec;color:#66261d;font:650 .84rem/1.45 Geist,system-ui,sans-serif}@media(prefers-reduced-motion:no-preference){button,.task-link-status{transition:background .15s ease}}</style></head><body><main><nav><span class="brand">Stash</span><span class="status" role="status" aria-live="polite">Loading Note…</span></nav><div class="toolbar" role="toolbar" aria-label="Formatting"><button disabled type="button" data-command="undo">Undo</button><button disabled type="button" data-command="redo">Redo</button><button disabled type="button" data-command="bold">Bold</button><button disabled type="button" data-command="italic">Italic</button><button disabled type="button" data-command="formatBlock" data-value="h2">Heading</button><button disabled type="button" data-command="insertUnorderedList">List</button><button disabled type="button" data-command="formatBlock" data-value="blockquote">Quote</button><button disabled type="button" data-insert="check">Checklist</button><button disabled type="button" data-insert="code">Code block</button><button disabled type="button" data-command="createLink">Link</button><button disabled class="save" type="button">Save Note</button></div><div id="editor" contenteditable="false" role="textbox" aria-multiline="true" aria-label="Note editor" aria-busy="true"></div><script>
      const editor=document.querySelector('#editor'),status=document.querySelector('.status');
      ${noteEditorMotion}
      const token=()=>localStorage.getItem('stash.memberToken')||'';
      const noteId=location.pathname.split('/')[2];
      let noteRevision=1;
      let baseDocument;
      let linkedTasks=[];
      const addSpan=(parent,span)=>{let node=document.createTextNode(span.text);for(const mark of span.marks||[]){const wrapper=document.createElement(mark==='bold'?'strong':mark==='italic'?'em':'code');wrapper.append(node);node=wrapper}if(span.href){const link=document.createElement('a');link.href=span.href;link.append(node);node=link}parent.append(node)};
      const render=document=>{editor.replaceChildren();for(const task of linkedTasks.filter(task=>task.relationshipState!=='linked')){const repair=document.createElement('aside');repair.className='task-repair';repair.dataset.taskLinks='';repair.contentEditable='false';repair.setAttribute('role','alert');const reason=task.relationshipState==='ambiguous'?'appears more than once':'is missing';repair.textContent='Block relationship needs repair: '+task.key+' source identity '+reason+'.';editor.append(repair)}for(const block of document.blocks){const element=document.createElement(block.type==='heading'?'h'+block.level:block.type==='quote'?'blockquote':block.type==='code'?'pre':block.type==='bullet'||block.type==='check'?'li':'p');element.dataset.blockType=block.type;element.dataset.blockKey=block.blockKey;if(block.id)element.dataset.blockId=block.id;if(block.type==='check'){const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=block.checked;checkbox.setAttribute('aria-label','Checklist state');checkbox.contentEditable='false';element.append(checkbox)}if(block.type==='code'){element.dataset.language=block.language||'';element.textContent=block.text}else for(const span of block.content)addSpan(element,span);editor.append(element);const tasks=linkedTasks.filter(task=>task.relationshipState==='linked'&&task.sourceBlock.blockId===block.id);if(tasks.length){const links=document.createElement('aside');links.className='task-links';links.dataset.taskLinks='';links.contentEditable='false';links.setAttribute('aria-label','Linked Tasks');for(const task of tasks){const item=document.createElement('span');item.className='task-link';const key=document.createElement('span');key.className='task-link-key';key.textContent=task.key;const title=document.createElement('span');title.textContent=task.title;const state=document.createElement('span');state.className='task-link-status';state.textContent=task.status.name;item.append(key,title,state);links.append(item)}editor.append(links)}}};
      const spans=node=>{const result=[];const visit=(current,marks=[],href)=>{if(current.nodeType===Node.TEXT_NODE){if(current.textContent)result.push({text:current.textContent,...(marks.length?{marks} :{}),...(href?{href}:{})});return}const tag=current.nodeName.toLowerCase();const next=[...marks];if(tag==='strong'||tag==='b')next.push('bold');if(tag==='em'||tag==='i')next.push('italic');if(tag==='code')next.push('code');current.childNodes.forEach(child=>visit(child,next,tag==='a'?current.getAttribute('href'):href))};node.childNodes.forEach(child=>visit(child));return result.length?result:[{text:''}]};
      const serialize=()=>{const elements=[...editor.children].filter(element=>!element.dataset.taskLinks).flatMap(element=>['ul','ol'].includes(element.tagName.toLowerCase())?[...element.children]:[element]);return{type:'doc',blocks:elements.map(element=>{const tag=element.tagName.toLowerCase(),id=element.dataset.blockId,identity=id?{id}:{},blockKey=element.dataset.blockKey;if(tag==='pre'||element.dataset.blockType==='code')return{type:'code',blockKey,text:element.innerText,...(element.dataset.language?{language:element.dataset.language}:{}),...identity};if(element.dataset.blockType==='check')return{type:'check',blockKey,checked:element.querySelector('input[type=checkbox]').checked,content:spans(element),...identity};if(/^h[1-3]$/.test(tag))return{type:'heading',blockKey,level:Number(tag[1]),content:spans(element),...identity};if(tag==='blockquote')return{type:'quote',blockKey,content:spans(element),...identity};if(tag==='li')return{type:'bullet',blockKey,content:spans(element),...identity};return{type:'paragraph',blockKey,content:spans(element),...identity}})}};
      const operations=()=>{const next=serialize(),before=new Map(baseDocument.blocks.map(block=>[block.blockKey,block])),after=new Map(next.blocks.map(block=>[block.blockKey,block])),ops=[];for(const block of next.blocks){if(!before.has(block.blockKey)){const index=next.blocks.indexOf(block);ops.push({id:crypto.randomUUID(),type:'insert_block',blockKey:block.blockKey,afterBlockKey:index?next.blocks[index-1].blockKey:null,block})}else if(JSON.stringify(before.get(block.blockKey))!==JSON.stringify(block))ops.push({id:crypto.randomUUID(),type:'replace_block',blockKey:block.blockKey,block})}for(const block of baseDocument.blocks)if(!after.has(block.blockKey))ops.push({id:crypto.randomUUID(),type:'delete_block',blockKey:block.blockKey});return ops};
      Promise.all([fetch('/api/notes/'+noteId,{headers:{authorization:'Bearer '+token()}}),fetch('/api/notes/'+noteId+'/linked-tasks',{headers:{authorization:'Bearer '+token()}})]).then(async([noteResponse,tasksResponse])=>{const body=await noteResponse.json();if(!noteResponse.ok)throw new Error(body.message);const taskBody=await tasksResponse.json();if(!tasksResponse.ok)throw new Error(taskBody.message);linkedTasks=taskBody.tasks;baseDocument=body.document;render(body.document);noteRevision=body.revision;editor.contentEditable='true';editor.setAttribute('aria-busy','false');document.querySelectorAll('button').forEach(button=>button.disabled=false);announce('Ready','ready');move('.toolbar',{from:{opacity:0,y:-8},to:{opacity:1,y:0}});move(editor,{from:{opacity:0,scale:.99},to:{opacity:1,scale:1},duration:.36})}).catch(error=>{announce(error.message||'The Note could not be loaded.','error')});
      document.querySelectorAll('[data-command]').forEach(button=>button.addEventListener('click',()=>{let value=button.dataset.value;if(button.dataset.command==='createLink')value=prompt('Link URL')||'';if(value!==''||button.dataset.command!=='createLink')document.execCommand(button.dataset.command,false,value);editor.focus()}));
      document.querySelectorAll('[data-insert]').forEach(button=>button.addEventListener('click',()=>{const element=document.createElement(button.dataset.insert==='code'?'pre':'li');element.dataset.blockType=button.dataset.insert;element.dataset.blockKey=crypto.randomUUID();const content=button.dataset.insert==='code'?'Write code':'Checklist item';element.textContent=content;if(button.dataset.insert==='check'){const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.setAttribute('aria-label','Checklist state');element.prepend(checkbox)}editor.append(element);editor.focus();move(element,{from:{opacity:0,y:6},to:{opacity:1,y:0}})}));
      document.querySelector('.save').addEventListener('click',async()=>{const pending=operations();if(!pending.length){announce('No changes to save','ready');return}announce('Saving…','saving');try{const response=await fetch('/api/notes/'+noteId,{method:'PUT',headers:{authorization:'Bearer '+token(),'content-type':'application/json'},body:JSON.stringify({baseRevision:noteRevision,operations:pending})});const body=await response.json();if(response.ok){noteRevision=body.revision;baseDocument=body.document;render(body.document);announce('Saved','success');move('.save',{from:{scale:.94},to:{scale:1}})}else announce(body.message||'The Note could not be saved.',response.status===409?'conflict':'error')}catch{announce('The Note could not be saved. Your changes remain in the editor.','error')}});
      </script></main></body></html>`);
      return true;
    },
  };
}
