# Generates the speech test fixtures with the text-to-speech voices that ship with Windows (System.Speech, fully offline,
# no account, no network, no cost). Output: 16 kHz mono 16-bit WAV files plus refs.json (what each file says).
#
#   powershell -ExecutionPolicy Bypass -File scripts/make-speech-fixtures.ps1
#
# These are SYNTHETIC voices: they exercise the streaming pipeline (latency, partials, endpointing) and give an
# optimistic accuracy figure. They are not a substitute for real interviewer audio.
param([string]$OutDir = (Join-Path $PSScriptRoot '..\tests\fixtures\speech'))

Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

$clips = @(
  @{ id = 'q01'; voice = 'Microsoft David Desktop'; rate = 0;  text = 'Tell me about a time when you had to lead a team through a difficult project.' },
  @{ id = 'q02'; voice = 'Microsoft Zira Desktop';  rate = 0;  text = 'What is your greatest strength and how has it helped you in your previous roles?' },
  @{ id = 'q03'; voice = 'Microsoft David Desktop'; rate = 1;  text = 'Can you walk me through how you would design a scalable notification system?' },
  @{ id = 'q04'; voice = 'Microsoft Zira Desktop';  rate = 1;  text = 'Why do you want to work at this company and what excites you about this role?' },
  @{ id = 'q05'; voice = 'Microsoft David Desktop'; rate = 0;  text = 'Describe a situation where you disagreed with a coworker and how you resolved it.' },
  @{ id = 'q06'; voice = 'Microsoft Zira Desktop';  rate = 0;  text = 'How do you prioritize your tasks when you have multiple deadlines at the same time?' },
  @{ id = 'q07'; voice = 'Microsoft David Desktop'; rate = 1;  text = 'What is the difference between a process and a thread and when would you use each?' },
  @{ id = 'q08'; voice = 'Microsoft Zira Desktop';  rate = 0;  text = 'Tell me about a project where you used Kubernetes and PostgreSQL in production.' },
  @{ id = 'q09'; voice = 'Microsoft David Desktop'; rate = 0;  text = 'Where do you see yourself in five years?' },
  @{ id = 'q10'; voice = 'Microsoft Zira Desktop';  rate = 0;  text = 'Do you have any questions for us?' },
  # A short pause inside a question: the recogniser must not treat it as the end.
  @{ id = 'p01'; voice = 'Microsoft David Desktop'; rate = 0;  text = 'Tell me about a time when <silence msec="900"/> you had to deliver bad news to a stakeholder.' }
)

$refs = [ordered]@{}
foreach ($c in $clips) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SelectVoice($c.voice)
  $synth.Rate = $c.rate
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $path = Join-Path $OutDir ($c.id + '.wav')
  $synth.SetOutputToWaveFile($path, $fmt)
  if ($c.text -match '<silence') { $synth.SpeakSsml('<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">' + $c.text.Replace('<silence msec="900"/>', '<break time="900ms"/>') + '</speak>') } else { $synth.Speak($c.text) }
  $synth.Dispose()
  $spoken = ($c.text -replace '<silence[^>]*/>', '' -replace '\s+', ' ').Trim()
  $refs[$c.id] = @{ text = $spoken; voice = $c.voice; bytes = (Get-Item $path).Length }
  '{0}  {1,8} bytes  {2}' -f $c.id, (Get-Item $path).Length, $c.voice
}
($refs | ConvertTo-Json -Depth 4) | Set-Content -Encoding UTF8 (Join-Path $OutDir 'refs.json')
'wrote refs.json'
