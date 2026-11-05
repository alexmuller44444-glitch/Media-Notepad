Add-Type -AssemblyName System.Drawing

# Yellow notepad icon (based on the supplied 48x48 reference), drawn at 1024px.
$size = 1024
$scale = $size / 48.0
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [Math]::Min($r * 2, [Math]::Min($w, $h))
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$yellow = [System.Drawing.Color]::FromArgb(255, 242, 202, 0)
$navy = [System.Drawing.Color]::FromArgb(255, 50, 69, 97)

# Body (x 7..41, y 4..44 in the 48px reference)
$body = New-RoundedPath (7 * $scale) (4 * $scale) (34 * $scale) (40 * $scale) (5 * $scale)
$g.FillPath((New-Object System.Drawing.SolidBrush($yellow)), $body)

# Four binding loops along the top edge
$inkBrush = New-Object System.Drawing.SolidBrush($navy)
foreach ($x in 11, 19, 27, 35) {
  $loop = New-RoundedPath ($x * $scale) (1 * $scale) (2 * $scale) (6 * $scale) (1 * $scale)
  $g.FillPath($inkBrush, $loop)
}

# Four text lines
$lines = @(
  @(14, 16, 20),
  @(14, 22, 17),
  @(14, 28, 20),
  @(14, 34, 14)
)
foreach ($line in $lines) {
  $shape = New-RoundedPath ($line[0] * $scale) ($line[1] * $scale) ($line[2] * $scale) (2 * $scale) (1 * $scale)
  $g.FillPath($inkBrush, $shape)
}

$out = Join-Path $PSScriptRoot "icon-src.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output "Saved $out"
