(function(){
  if(!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) return;
  let pc=null,dc=null,micStream=null,remoteAudio=null,connected=false,muted=false,overlay=null,statusEl=null,muteBtn=null;
  const token=()=>localStorage.getItem('mcc_token')||'';
  function context(){
    const txt=(id)=>document.getElementById(id)?.textContent?.trim()||'';
    return [
      `Net worth: ${txt('netWorth')}`,
      `Safe to spend: ${txt('safe')}`,
      `Emergency reserve: ${txt('reserve')}`,
      `Financial health score: ${txt('score')}`,
      `Credit score: ${txt('creditScoreDisplay')}`,
      `Total debt: ${txt('debtTotal')}`,
      `Minimum debt payments: ${txt('debtMins')}`,
      `DTI: ${txt('dtiDisplay')}`,
      `Monthly take-home: ${txt('budgetIncome')}`,
      `Monthly planned spending: ${txt('budgetPlanned')}`,
      `Monthly actual spending: ${txt('budgetActual')}`
    ].join('\n');
  }
  function styles(){if(document.getElementById('moneyVoiceStyles'))return;const s=document.createElement('style');s.id='moneyVoiceStyles';s.textContent=`
  .moneyTalkBtn{background:#111827!important;color:#fff!important;border-radius:12px!important;padding:12px 16px!important;font-weight:800!important}
  .moneyVoiceOverlay{position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.55);backdrop-filter:blur(8px);display:none;place-items:center;padding:18px}
  .moneyVoicePanel{width:min(440px,100%);background:#fff;color:#172033;border-radius:26px;padding:28px;box-shadow:0 30px 90px rgba(15,23,42,.3);text-align:center}
  .moneyVoiceOrb{width:104px;height:104px;border-radius:50%;margin:4px auto 20px;background:radial-gradient(circle at 34% 28%,#fff,#dbe4f0 26%,#64748b 62%,#111827);box-shadow:0 0 0 10px rgba(17,24,39,.05),0 20px 60px rgba(17,24,39,.2);animation:moneyPulse 2.3s ease-in-out infinite}
  .moneyVoicePanel.speaking .moneyVoiceOrb{animation-duration:.7s}@keyframes moneyPulse{0%,100%{transform:scale(.96)}50%{transform:scale(1.04)}}
  .moneyVoicePanel h2{font-size:27px;margin:0 0 7px;letter-spacing:-.04em}.moneyVoiceStatus{color:#667085;font-size:14px;min-height:22px;margin-bottom:20px}
  .moneyVoiceActions{display:grid;grid-template-columns:1fr 1fr;gap:9px}.moneyVoiceActions button{min-height:46px;border-radius:12px}.moneyVoiceEnd{background:#fff1f0!important;color:#b42318!important}.moneyVoiceFoot{font-size:11px;color:#98a2b3;line-height:1.45;margin-top:16px}
  @media(max-width:620px){.moneyVoiceOverlay{align-items:end;padding:0}.moneyVoicePanel{width:100%;border-radius:26px 26px 0 0;padding:26px 18px 30px}.moneyVoiceActions{grid-template-columns:1fr}}
  `;document.head.appendChild(s)}
  function make(){if(overlay)return;styles();overlay=document.createElement('div');overlay.className='moneyVoiceOverlay';overlay.innerHTML=`<div class="moneyVoicePanel" id="moneyVoicePanel"><div class="moneyVoiceOrb"></div><h2>Money Guide</h2><div class="moneyVoiceStatus" id="moneyVoiceStatus">Ready when you are</div><audio id="moneyVoiceAudio" autoplay playsinline></audio><div class="moneyVoiceActions"><button id="moneyVoiceMute" class="ghost">Mute</button><button id="moneyVoiceHide" class="ghost">Hide</button><button id="moneyVoiceEnd" class="moneyVoiceEnd">End conversation</button></div><div class="moneyVoiceFoot">Money Guide can use the financial information saved in your account to explain your numbers and help you think through decisions. Educational guidance only.</div></div>`;document.body.appendChild(overlay);statusEl=document.getElementById('moneyVoiceStatus');remoteAudio=document.getElementById('moneyVoiceAudio');muteBtn=document.getElementById('moneyVoiceMute');muteBtn.onclick=toggleMute;document.getElementById('moneyVoiceHide').onclick=()=>overlay.style.display='none';document.getElementById('moneyVoiceEnd').onclick=end}
  function setStatus(t){if(statusEl)statusEl.textContent=t}function show(){make();overlay.style.display='grid'}
  async function waitIce(peer,timeout=1800){if(peer.iceGatheringState==='complete')return;await new Promise(resolve=>{const done=()=>{peer.removeEventListener('icegatheringstatechange',check);resolve()},check=()=>{if(peer.iceGatheringState==='complete')done()};peer.addEventListener('icegatheringstatechange',check);setTimeout(done,timeout)})}
  function sendContext(){if(!dc||dc.readyState!=='open')return;dc.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'system',content:[{type:'input_text',text:`Current Money Command Center screen context:\n${context()}`} ]}}))}
  async function start(){if(connected){show();sendContext();return}show();setStatus('Requesting microphone…');try{micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});setStatus('Connecting to Money Guide…');const r=await fetch('/api/money-guide/live-session',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+token()},body:JSON.stringify({context:context()})});const data=await r.json();if(!r.ok)throw new Error(data?.error||'Could not start Money Guide.');pc=new RTCPeerConnection();pc.ontrack=e=>{remoteAudio.srcObject=e.streams[0];remoteAudio.play().catch(()=>{})};micStream.getTracks().forEach(t=>pc.addTrack(t,micStream));dc=pc.createDataChannel('oai-events');dc.onopen=()=>{connected=true;setStatus('Listening…');sendContext()};dc.onmessage=e=>handle(e.data);pc.onconnectionstatechange=()=>{if(['failed','closed'].includes(pc?.connectionState))end()};const offer=await pc.createOffer();await pc.setLocalDescription(offer);await waitIce(pc);const sdp=await fetch('https://api.openai.com/v1/realtime/calls',{method:'POST',headers:{Authorization:`Bearer ${data.value}`,'Content-Type':'application/sdp'},body:pc.localDescription.sdp});const answer=await sdp.text();if(!sdp.ok)throw new Error(answer||'Voice connection failed.');await pc.setRemoteDescription({type:'answer',sdp:answer})}catch(e){setStatus(e?.message||'Could not start voice.');cleanup()}}
  function handle(raw){try{const ev=JSON.parse(raw),t=ev.type||'',p=document.getElementById('moneyVoicePanel');if(t.includes('speech_started')){setStatus('Listening…');p?.classList.remove('speaking')}else if(t==='response.created'||t.includes('output_audio.delta')){setStatus('Money Guide is speaking…');p?.classList.add('speaking')}else if(t==='response.done'||t.includes('output_audio.done')){setStatus('Listening…');p?.classList.remove('speaking')}else if(t==='error')setStatus(ev.error?.message||'Voice session error.')}catch{}}
  function toggleMute(){if(!micStream)return;muted=!muted;micStream.getAudioTracks().forEach(t=>t.enabled=!muted);muteBtn.textContent=muted?'Unmute':'Mute';setStatus(muted?'Microphone muted':'Listening…')}
  function cleanup(){connected=false;muted=false;try{dc?.close()}catch{}dc=null;try{pc?.close()}catch{}pc=null;try{micStream?.getTracks().forEach(t=>t.stop())}catch{}micStream=null;if(remoteAudio)remoteAudio.srcObject=null;document.getElementById('moneyVoicePanel')?.classList.remove('speaking');if(muteBtn)muteBtn.textContent='Mute'}
  function end(){cleanup();setStatus('Conversation ended');setTimeout(()=>{if(overlay)overlay.style.display='none'},350)}
  function install(){styles();make();const section=document.getElementById('ai');if(!section||document.getElementById('moneyTalkBtn'))return;const first=section.querySelector('.card');if(first){const b=document.createElement('button');b.id='moneyTalkBtn';b.className='moneyTalkBtn';b.textContent='🎙 Talk to Money Guide';b.onclick=start;first.appendChild(b)} }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(install,200));else setTimeout(install,200);window.addEventListener('beforeunload',cleanup);
})();