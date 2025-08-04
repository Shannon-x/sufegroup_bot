// 现代化验证页面交互脚本

// 检测是否为触摸设备
const isTouchDevice = () => {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
};

// 磁吸按钮效果
const magneticButton = document.querySelector('.magnetic-button');
if (magneticButton && !isTouchDevice()) {
  let buttonRect = magneticButton.getBoundingClientRect();
  
  // 更新按钮位置（窗口大小改变时）
  window.addEventListener('resize', () => {
    buttonRect = magneticButton.getBoundingClientRect();
  });

  magneticButton.addEventListener('mousemove', (e) => {
    const x = e.clientX - buttonRect.left - buttonRect.width / 2;
    const y = e.clientY - buttonRect.top - buttonRect.height / 2;
    
    // 磁吸效果
    const distance = Math.sqrt(x * x + y * y);
    const maxDistance = 50;
    
    if (distance < maxDistance) {
      const force = (maxDistance - distance) / maxDistance;
      magneticButton.style.transform = `translate(${x * force * 0.2}px, ${y * force * 0.2}px) scale(1.02)`;
    }
  });

  magneticButton.addEventListener('mouseleave', () => {
    magneticButton.style.transform = 'translate(0, 0) scale(1)';
  });
}

// 粒子效果
const canvas = document.getElementById('particles');
const ctx = canvas.getContext('2d');
let particles = [];

// 设置画布大小
const resizeCanvas = () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
};
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// 粒子类
class Particle {
  constructor() {
    this.x = Math.random() * canvas.width;
    this.y = Math.random() * canvas.height;
    this.size = Math.random() * 2 + 0.5;
    this.speedX = (Math.random() - 0.5) * 0.5;
    this.speedY = (Math.random() - 0.5) * 0.5;
    this.opacity = Math.random() * 0.5 + 0.2;
  }

  update() {
    this.x += this.speedX;
    this.y += this.speedY;

    // 边界检测
    if (this.x < 0 || this.x > canvas.width) this.speedX *= -1;
    if (this.y < 0 || this.y > canvas.height) this.speedY *= -1;
  }

  draw() {
    // 霓虹渐变效果
    const gradient = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, this.size);
    gradient.addColorStop(0, `rgba(255, 16, 240, ${this.opacity})`);
    gradient.addColorStop(0.5, `rgba(139, 92, 246, ${this.opacity * 0.8})`);
    gradient.addColorStop(1, `rgba(6, 182, 212, ${this.opacity * 0.6})`);
    
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

// 创建粒子
for (let i = 0; i < 50; i++) {
  particles.push(new Particle());
}

// 动画循环
const animateParticles = () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  particles.forEach(particle => {
    particle.update();
    particle.draw();
  });
  
  requestAnimationFrame(animateParticles);
};
animateParticles();

// 倒计时功能
let countdownInterval;
const countdownElement = document.getElementById('countdown');
const timerProgress = document.querySelector('.timer-progress');
let remainingMinutes = parseInt(countdownElement.textContent);
let totalSeconds = remainingMinutes * 60;
let currentSeconds = totalSeconds;

const updateCountdown = () => {
  currentSeconds--;
  
  if (currentSeconds <= 0) {
    clearInterval(countdownInterval);
    window.location.reload();
    return;
  }
  
  const minutes = Math.floor(currentSeconds / 60);
  const seconds = currentSeconds % 60;
  
  // 更新显示
  countdownElement.textContent = minutes;
  
  // 更新进度环 - 修正SVG圆周长
  const progress = (totalSeconds - currentSeconds) / totalSeconds;
  const circumference = 2 * Math.PI * 54; // 半径54的圆周长
  const offset = circumference * progress;
  timerProgress.style.strokeDashoffset = offset;
  
  // 紧急状态
  if (minutes < 2) {
    timerProgress.style.stroke = '#ff4466';
    countdownElement.style.color = '#ff4466';
  }
};

countdownInterval = setInterval(updateCountdown, 1000);

// 表单提交
const verifyForm = document.getElementById('verifyForm');
const submitBtn = document.getElementById('submitBtn');

// Turnstile 回调
let turnstileToken = null;

window.onTurnstileSuccess = function(token) {
  turnstileToken = token;
  submitBtn.disabled = false;
  submitBtn.style.cursor = 'pointer';
  submitBtn.style.opacity = '1';
  
  // 成功动画
  submitBtn.innerHTML = '<span>✓ 已验证 - 点击完成</span>';
  console.log('Turnstile验证成功，按钮已启用');
};

window.onTurnstileError = function() {
  showError('人机验证失败，请刷新页面重试');
};

verifyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  if (!turnstileToken) {
    showError('请先完成人机验证');
    return;
  }
  
  // 显示加载状态
  submitBtn.classList.add('loading');
  submitBtn.disabled = true;
  
  try {
    const token = verifyForm.querySelector('input[name="token"]').value;
    
    const response = await fetch('/api/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        token: token,
        turnstileToken: turnstileToken
      })
    });
    
    const data = await response.json();
    
    if (data.success) {
      showSuccess(data.message);
      
      // 成功动画
      const mainCard = document.querySelector('.main-card');
      mainCard.style.transform = 'scale(0.95)';
      mainCard.style.opacity = '0';
      
      setTimeout(() => {
        window.location.href = data.redirectUrl;
      }, 1000);
    } else {
      showError(data.message);
      submitBtn.classList.remove('loading');
      submitBtn.disabled = false;
    }
  } catch (error) {
    showError('网络错误，请重试');
    submitBtn.classList.remove('loading');
    submitBtn.disabled = false;
  }
});

// 显示错误消息
function showError(message) {
  const errorElement = document.getElementById('errorMessage');
  errorElement.textContent = message;
  errorElement.style.display = 'block';
  
  // 震动效果
  const mainCard = document.querySelector('.main-card');
  mainCard.style.animation = 'shake 0.5s';
  setTimeout(() => {
    mainCard.style.animation = '';
  }, 500);
}

// 显示成功消息
function showSuccess(message) {
  const successElement = document.getElementById('successMessage');
  successElement.textContent = message;
  successElement.style.display = 'block';
}

// 震动动画
const style = document.createElement('style');
style.textContent = `
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    10%, 30%, 50%, 70%, 90% { transform: translateX(-5px); }
    20%, 40%, 60%, 80% { transform: translateX(5px); }
  }
`;
document.head.appendChild(style);

// 页面加载动画
window.addEventListener('load', () => {
  const bentoItems = document.querySelectorAll('.bento-item');
  bentoItems.forEach((item, index) => {
    item.style.opacity = '0';
    item.style.transform = 'translateY(20px)';
    
    setTimeout(() => {
      item.style.transition = 'all 0.6s ease';
      item.style.opacity = '1';
      item.style.transform = 'translateY(0)';
    }, index * 100);
  });
  
  // Logo 入场动画
  const logoWrapper = document.querySelector('.logo-wrapper');
  logoWrapper.style.animation = 'fadeInScale 0.8s ease';
});

// 添加入场动画
const fadeInStyle = document.createElement('style');
fadeInStyle.textContent = `
  @keyframes fadeInScale {
    from {
      opacity: 0;
      transform: scale(0.8);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
`;
document.head.appendChild(fadeInStyle);

// 检测页面可见性变化
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // 页面隐藏时暂停动画
    if (countdownInterval) {
      clearInterval(countdownInterval);
    }
  } else {
    // 页面可见时恢复动画
    countdownInterval = setInterval(updateCountdown, 1000);
  }
});