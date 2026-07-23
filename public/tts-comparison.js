const players = document.querySelectorAll('audio');
players.forEach(player => player.addEventListener('play', () => {
  players.forEach(other => {
    if (other !== player) other.pause();
  });
}));
