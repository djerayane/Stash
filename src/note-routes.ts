import { json, readJson, type HttpRoute } from "./http-routing.js";
import { InvalidNoteEdit, InvalidNoteInput, InvalidNoteTriageInput, presentNoteTriageResult, type NoteService } from "./notes.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

export function noteRoutes(service: NoteService, memberAccess: MemberAccessResolver): HttpRoute {
  return {
    matches: (request, url) => (request.method === "POST" && /^\/api\/workspaces\/[^/]+\/notes$/.test(url.pathname))
      || (request.method === "GET" && /^\/api\/workspaces\/[^/]+\/inbox$/.test(url.pathname))
      || (request.method === "POST" && /^\/api\/workspaces\/[^/]+\/inbox\/[^/]+\/triage$/.test(url.pathname))
      || (["GET", "PUT"].includes(request.method ?? "") && /^\/api\/notes\/[^/]+$/.test(url.pathname)),
    async handle(request, response, url) {
      const access = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!access) {
        json(response, 401, { error: "unauthorized", message: "A valid Member session is required." });
        return true;
      }
      try {
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
          if (result.status === "updated") {
            const { createdByMemberId: _, ...note } = result.note;
            json(response, 200, { ...note, portableProjection: { format: result.projection.schema, state: "recorded" } });
          } else if (result.status === "revision_conflict_preserved") {
            json(response, 409, { error: "revision_conflict", message: "This Note changed since editing began. Your version was preserved for conflict resolution." });
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
            message: "A Note requires content and valid optional Project, tags, and reminder fields.",
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

export function noteEditorRoute(): HttpRoute {
  return {
    matches: (request, url) => request.method === "GET" && /^\/notes\/[0-9a-f-]+\/edit$/.test(url.pathname),
    async handle(_request, response) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Edit Note · Stash</title><style>
      :root{font-family:Geist,system-ui,sans-serif;color:#17201b;background:#f3f1e9}body{margin:0}main{max-width:54rem;margin:auto;padding:clamp(1rem,5vw,4rem)}nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:2.5rem}.brand{font-weight:750;letter-spacing:-.03em}.toolbar{position:sticky;top:1rem;display:flex;flex-wrap:wrap;gap:.35rem;padding:.5rem;background:#17201b;border-radius:.75rem}button{border:0;border-radius:.45rem;padding:.62rem .8rem;color:#fff;background:transparent;font:inherit;font-weight:650}button:hover,button:focus-visible{background:#34453b;outline:2px solid #e8a93f;outline-offset:2px}button:disabled{cursor:not-allowed;opacity:.45}#editor{min-height:26rem;margin-top:1rem;padding:clamp(1.2rem,4vw,3rem);background:#fff;border:1px solid #d7d3c7;border-radius:.75rem;font:1.1rem/1.75 Georgia,serif;box-shadow:0 1rem 4rem #17201b12}#editor:focus{outline:3px solid #b87818;outline-offset:3px}.status{min-height:1.5em;color:#566158}.save{background:#d98b22;color:#17201b;margin-left:auto}@media(prefers-reduced-motion:no-preference){button{transition:background .15s ease}}</style></head><body><main><nav><span class="brand">Stash</span><span class="status" role="status" aria-live="polite">Loading Note…</span></nav><div class="toolbar" role="toolbar" aria-label="Formatting"><button disabled type="button" data-command="undo">Undo</button><button disabled type="button" data-command="redo">Redo</button><button disabled type="button" data-command="bold">Bold</button><button disabled type="button" data-command="italic">Italic</button><button disabled type="button" data-command="formatBlock" data-value="h2">Heading</button><button disabled type="button" data-command="insertUnorderedList">List</button><button disabled type="button" data-command="formatBlock" data-value="blockquote">Quote</button><button disabled type="button" data-insert="check">Checklist</button><button disabled type="button" data-insert="code">Code block</button><button disabled type="button" data-command="createLink">Link</button><button disabled class="save" type="button">Save Note</button></div><div id="editor" contenteditable="false" role="textbox" aria-multiline="true" aria-label="Note editor" aria-busy="true"></div><script>
      const editor=document.querySelector('#editor'),status=document.querySelector('.status');
      const token=()=>localStorage.getItem('stash.memberToken')||'';
      const noteId=location.pathname.split('/')[2];
      let noteRevision=1;
      const addSpan=(parent,span)=>{let node=document.createTextNode(span.text);for(const mark of span.marks||[]){const wrapper=document.createElement(mark==='bold'?'strong':mark==='italic'?'em':'code');wrapper.append(node);node=wrapper}if(span.href){const link=document.createElement('a');link.href=span.href;link.append(node);node=link}parent.append(node)};
      const render=document=>{editor.replaceChildren();for(const block of document.blocks){const element=document.createElement(block.type==='heading'?'h'+block.level:block.type==='quote'?'blockquote':block.type==='code'?'pre':block.type==='bullet'||block.type==='check'?'li':'p');element.dataset.blockType=block.type;if(block.id)element.dataset.blockId=block.id;if(block.type==='check')element.dataset.checked=String(block.checked);if(block.type==='code'){element.dataset.language=block.language||'';element.textContent=block.text}else for(const span of block.content)addSpan(element,span);editor.append(element)}};
      const spans=node=>{const result=[];const visit=(current,marks=[],href)=>{if(current.nodeType===Node.TEXT_NODE){if(current.textContent)result.push({text:current.textContent,...(marks.length?{marks} :{}),...(href?{href}:{})});return}const tag=current.nodeName.toLowerCase();const next=[...marks];if(tag==='strong'||tag==='b')next.push('bold');if(tag==='em'||tag==='i')next.push('italic');if(tag==='code')next.push('code');current.childNodes.forEach(child=>visit(child,next,tag==='a'?current.getAttribute('href'):href))};node.childNodes.forEach(child=>visit(child));return result.length?result:[{text:''}]};
      const serialize=()=>{const elements=[...editor.children].flatMap(element=>['ul','ol'].includes(element.tagName.toLowerCase())?[...element.children]:[element]);return{type:'doc',blocks:elements.map(element=>{const tag=element.tagName.toLowerCase(),id=element.dataset.blockId,identity=id?{id}:{};if(tag==='pre'||element.dataset.blockType==='code')return{type:'code',text:element.innerText,...(element.dataset.language?{language:element.dataset.language}:{}),...identity};if(element.dataset.blockType==='check')return{type:'check',checked:element.dataset.checked==='true',content:spans(element),...identity};if(/^h[1-3]$/.test(tag))return{type:'heading',level:Number(tag[1]),content:spans(element),...identity};if(tag==='blockquote')return{type:'quote',content:spans(element),...identity};if(tag==='li')return{type:'bullet',content:spans(element),...identity};return{type:'paragraph',content:spans(element),...identity}})}};
      fetch('/api/notes/'+noteId,{headers:{authorization:'Bearer '+token()}}).then(async response=>{const body=await response.json();if(!response.ok)throw new Error(body.message);render(body.document);noteRevision=body.revision;editor.contentEditable='true';editor.setAttribute('aria-busy','false');document.querySelectorAll('button').forEach(button=>button.disabled=false);status.textContent='Ready'}).catch(error=>{status.textContent=error.message||'The Note could not be loaded.'});
      document.querySelectorAll('[data-command]').forEach(button=>button.addEventListener('click',()=>{let value=button.dataset.value;if(button.dataset.command==='createLink')value=prompt('Link URL')||'';if(value!==''||button.dataset.command!=='createLink')document.execCommand(button.dataset.command,false,value);editor.focus()}));
      document.querySelectorAll('[data-insert]').forEach(button=>button.addEventListener('click',()=>{const element=document.createElement(button.dataset.insert==='code'?'pre':'li');element.dataset.blockType=button.dataset.insert;const content=button.dataset.insert==='code'?'Write code':'Checklist item';element.textContent=content;if(button.dataset.insert==='check')element.dataset.checked='false';editor.append(element);editor.focus()}));
      document.querySelector('.save').addEventListener('click',async()=>{status.textContent='Saving…';try{const response=await fetch('/api/notes/'+noteId,{method:'PUT',headers:{authorization:'Bearer '+token(),'content-type':'application/json'},body:JSON.stringify({revision:noteRevision,document:serialize()})});const body=await response.json();if(response.ok){noteRevision=body.revision;status.textContent='Saved'}else status.textContent=body.message||'The Note could not be saved.'}catch{status.textContent='The Note could not be saved. Your changes remain in the editor.'}});
      </script></main></body></html>`);
      return true;
    },
  };
}
