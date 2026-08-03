PRINT 'Creating EdictResources table...';
CREATE TABLE EdictResources (
    id INT PRIMARY KEY IDENTITY(1,1),
    edictId INT NOT NULL,
    resourcePath NVARCHAR(255) NOT NULL,
    description NVARCHAR(255) NULL,
    FOREIGN KEY (edictId) REFERENCES Edicts(id) ON DELETE NO ACTION
);
GO

PRINT 'Inserting IP addresses...';
INSERT INTO Users (username, passwordHash) VALUES
('oswald_admin', '$2b$10$aAzmbxTi7wV9AyyhyGC4iOiSZ2Acnv27Nd2Bw69/0TQo7WI8rXlR.'); -- password: admin
GO