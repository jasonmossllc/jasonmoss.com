// Design pass (Nov 2026): sticky header after the hero + gentle scroll reveals.
(function(){
  var d=document.documentElement;d.classList.add('js');
  function go(){
    window.__rv=1;
    var hero=document.querySelector('.hero,.pod-hero,.bt-hero,.ap-hero,.legal-hero'),stick=document.getElementById('stick');
    if(hero&&stick&&'IntersectionObserver' in window){
      new IntersectionObserver(function(e){stick.classList.toggle('on',!e[0].isIntersecting)},{rootMargin:'-80px 0px 0px 0px'}).observe(hero);
    }
    var els=[].slice.call(document.querySelectorAll('.rv'));
    if(!('IntersectionObserver' in window)){els.forEach(function(el){el.classList.add('in')});return}
    var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}})},{rootMargin:'0px 0px -8% 0px',threshold:.08});
    els.forEach(function(el){io.observe(el)});
  }
  if(document.readyState!=='loading')go();else document.addEventListener('DOMContentLoaded',go);
})();
